// accessory.js
const MODE_TO_HOMEKIT = { off: 0, heat: 1, cool: 2, "heat and cool": 3 };
const HOMEKIT_TO_MODE = ["off", "heat", "cool", "heat and cool"];

// Unit helpers
const f2c = (f) => (Number(f) - 32) * 5 / 9;
const c2f = (c) => (Number(c) * 9 / 5) + 32;
const clamp = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
};

class LennoxZoneAccessory {
  constructor(platform, zoneId) {
    this.platform = platform;
    this.zoneId = zoneId;
    this.name = `Lennox Zone ${zoneId}`;
    this.log = platform.log;

    // Use the platform's HAP singletons
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;

    // Internal state (HomeKit expects °C)
    // Provide safe defaults within HomeKit ranges so no warnings appear
    this.haveFirstStatus = false;
    this.tempC = 22.0;      // ~72°F
    this.humidity = 50;
    this.mode = "off";
    this.hspC = 20.5;       // ~69°F  (>= 10.0°C)
    this.cspC = 23.0;       // ~73°F  (>= 15.5°C)

    const accUuid = platform.api.hap.uuid.generate(`${platform.host}-${zoneId}`);
    this.accessory = new platform.api.platformAccessory(this.name, accUuid);

    // Main Thermostat service
    this.service = this.accessory.getService(this.Service.Thermostat)
      || this.accessory.addService(this.Service.Thermostat, this.name);

    // DO NOT force TemperatureDisplayUnits; let Home decide (iOS setting).
    // We always send °C to HomeKit characteristics.

    // Current state (OFF/HEAT/COOL)
    this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this._currentState());

    // Target mode
    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [0, 1, 2, 3] })
      .onGet(() => MODE_TO_HOMEKIT[this.mode] ?? 0)
      .onSet(async (value) => {
        const mode = HOMEKIT_TO_MODE[value] || "off";
        this.log(`[Zone ${this.zoneId}] set TargetMode -> ${mode}`);
        try {
          await this.platform.client.setZoneMode(this.zoneId, mode);
          this.mode = mode;
        } catch (e) {
          this.log.error(`[Zone ${this.zoneId}] setZoneMode failed: ${e?.message || e}`);
          throw e;
        }
      });

    // Current temperature (°C)
    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.tempC);

    // Cooling threshold (°C): 15.5–32.2 (60–90°F)
    this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 15.5, maxValue: 32.2, minStep: 0.1 })
      .onGet(() => clamp(this.cspC, 15.5, 32.2))
      .onSet(async (valC) => {
        const cC = clamp(valC, 15.5, 32.2);
        const cF = Math.round(c2f(cC));
        this.log(`[Zone ${this.zoneId}] set CoolSP -> ${cC.toFixed(1)}°C (${cF}°F)`);
        try {
          await this.platform.client.setZoneSetpoints(this.zoneId, { csp: cF, hsp: this.hspC, mode: this.mode });
          this.cspC = cC;
        } catch (e) {
          this.log.error(`[Zone ${this.zoneId}] set csp failed: ${e?.message || e}`);
          throw e;
        }
      });

    // Heating threshold (°C): 10.0–29.4 (50–85°F)
    this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 10.0, maxValue: 29.4, minStep: 0.1 })
      .onGet(() => clamp(this.hspC, 10.0, 29.4))
      .onSet(async (valC) => {
        const hC = clamp(valC, 10.0, 29.4);
        const hF = Math.round(c2f(hC));
        this.log(`[Zone ${this.zoneId}] set HeatSP -> ${hC.toFixed(1)}°C (${hF}°F)`);
        try {
          await this.platform.client.setZoneSetpoints(this.zoneId, { csp: this.cspC, hsp: hF, mode: this.mode });
          this.hspC = hC;
        } catch (e) {
          this.log.error(`[Zone ${this.zoneId}] set hsp failed: ${e?.message || e}`);
          throw e;
        }
      });

    // Optional humidity
    const humidSvc = this.accessory.getService(this.Service.HumiditySensor)
      || this.accessory.addService(this.Service.HumiditySensor, `${this.name} Humidity`);
    humidSvc.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.humidity);

    // Accessory info
    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, "Lennox")
      .setCharacteristic(this.Characteristic.Model, "S40")
      .setCharacteristic(this.Characteristic.SerialNumber, `zone-${zoneId}`);

    platform.api.registerPlatformAccessories(
      "homebridge-lennox-s40",
      "LennoxS40Platform",
      [this.accessory]
    );
  }

  _currentState() {
    const C = this.Characteristic.CurrentHeatingCoolingState;
    if (this.mode === "heat") return C.HEAT;
    if (this.mode === "cool") return C.COOL;
    // If "heat and cool", HomeKit Current state should still reflect *active* op,
    // but without tempOperation we show OFF to avoid invalid value=3.
    return C.OFF;
  }

  // Called with S40 status (temps in °F)
  applyZoneStatus(s) {
    if (!s) return;
    const p = s.period || {};
    this.log(`[Zone ${this.zoneId}] raw: temp=${s.temperature}°F, hsp=${p.hsp}°F, csp=${p.csp}°F, mode=${p.systemMode}`);

    if (typeof s.temperature === "number") this.tempC = f2c(s.temperature);
    else this.log.debug?.(`[Zone ${this.zoneId}] no temperature in packet; keeping last ${this.tempC ?? 'n/a'}°C`);
    if (typeof s.humidity === "number") this.humidity = s.humidity;
    if (typeof p.hsp === "number") this.hspC = f2c(p.hsp);
    if (typeof p.csp === "number") this.cspC = f2c(p.csp);
    if (typeof p.systemMode === "string") this.mode = p.systemMode;

    this.haveFirstStatus = true;

    const C = this.Characteristic;
    const t = clamp(this.tempC, -40, 100);
    const h = clamp(this.hspC, 10.0, 29.4);
    const c = clamp(this.cspC, 15.5, 32.2);
    this.log(`[Zone ${this.zoneId}] push HK: temp=${t.toFixed(1)}°C (${Math.round(c2f(t))}°F), hsp=${h.toFixed(1)}°C, csp=${c.toFixed(1)}°C, mode=${this.mode}`);

    try {
      this.service.updateCharacteristic(C.CurrentTemperature, t);
      this.service.updateCharacteristic(C.TargetHeatingCoolingState, MODE_TO_HOMEKIT[this.mode] ?? 0);
      this.service.updateCharacteristic(C.CoolingThresholdTemperature, c);
      this.service.updateCharacteristic(C.HeatingThresholdTemperature, h);
      const humidSvc = this.accessory.getService(this.Service.HumiditySensor);
      if (humidSvc && Number.isFinite(this.humidity)) {
        humidSvc.updateCharacteristic(C.CurrentRelativeHumidity, this.humidity);
      }
      this.log(`[Zone ${this.zoneId}] HK updated OK`);
    } catch (e) {
      this.log.error(`[Zone ${this.zoneId}] HK update failed: ${e?.message || e}`);
    }
  }
}

module.exports = { LennoxZoneAccessory };
