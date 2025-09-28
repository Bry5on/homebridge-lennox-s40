// accessory.js
const MODE_TO_HOMEKIT = { off: 0, heat: 1, cool: 2, "heat and cool": 3 };
const HOMEKIT_TO_MODE = ["off", "heat", "cool", "heat and cool"];

// Unit helpers
const f2c = f => (Number(f) - 32) * 5 / 9;
const c2f = c => (Number(c) * 9 / 5) + 32;
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

    // HAP singletons (with fallbacks)
    this.Service = platform.Service || platform.api?.hap?.Service;
    this.Characteristic = platform.Characteristic || platform.api?.hap?.Characteristic;

    // Internal state (HomeKit expects °C)
    this.haveFirstStatus = false;
    this.tempC = 22.0;   // ~72°F
    this.humidity = 50;
    this.mode = "off";
    this.hspC = 20.5;    // ~69°F
    this.cspC = 23.0;    // ~73°F

    const accUuid = platform.api.hap.uuid.generate(`${platform.host}-${zoneId}`);
    this.accessory = new platform.api.platformAccessory(this.name, accUuid);

    // Main Thermostat service
    this.service =
      this.accessory.getService(this.Service.Thermostat) ||
      this.accessory.addService(this.Service.Thermostat, this.name);

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
        await this.platform.client.setZoneMode(this.zoneId, mode);
        this.mode = mode;
      });

    // Current temperature (°C)
    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.tempC);

    this.log(`[Zone ${this.zoneId}] wiring handlers…`);

    // Cooling threshold (°C): 15.5–32.2 (60–90°F)
this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
  .setProps({ minValue: 15.5, maxValue: 32.2, minStep: 0.1 })
  .onGet(() => Math.max(15.5, Math.min(32.2, Number(this.cspC))))
  .onSet(async (valC) => {
    this.cspC = Math.max(15.5, Math.min(32.2, Number(valC)));
    this.log(`[Zone ${this.zoneId}] onSet CoolSP -> ${this.cspC.toFixed(1)}°C`);
    try {
      await this.sendSetpointsToLennox();
      this.log(`[Zone ${this.zoneId}] setpoints push OK`);
    } catch (e) {
      this.log.error(`[Zone ${this.zoneId}] setpoints push FAILED: ${e?.message || e}`);
      throw e;
    }
  });

// Heating threshold (°C): 10.0–29.4 (50–85°F)
this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
  .setProps({ minValue: 10.0, maxValue: 29.4, minStep: 0.1 })
  .onGet(() => Math.max(10.0, Math.min(29.4, Number(this.hspC))))
  .onSet(async (valC) => {
    this.hspC = Math.max(10.0, Math.min(29.4, Number(valC)));
    this.log(`[Zone ${this.zoneId}] onSet HeatSP -> ${this.hspC.toFixed(1)}°C`);
    try {
      await this.sendSetpointsToLennox();
      this.log(`[Zone ${this.zoneId}] setpoints push OK`);
    } catch (e) {
      this.log.error(`[Zone ${this.zoneId}] setpoints push FAILED: ${e?.message || e}`);
      throw e;
    }
  });

    // Optional humidity
    const humidSvc =
      this.accessory.getService(this.Service.HumiditySensor) ||
      this.accessory.addService(this.Service.HumiditySensor, `${this.name} Humidity`);
    humidSvc.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.humidity);

    // Accessory info
    this.accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, "Lennox")
      .setCharacteristic(this.Characteristic.Model, "S40")
      .setCharacteristic(this.Characteristic.SerialNumber, `zone-${zoneId}`);

    this.platform.api.registerPlatformAccessories(
      "homebridge-lennox-s40",
      "LennoxS40Platform",
      [this.accessory]
    );
  }

 sendSetpointsToLennox() {
  const hF = Math.round((Number(this.hspC) * 9/5) + 32);
  const cF = Math.round((Number(this.cspC) * 9/5) + 32);
  this.log(`[Zone ${this.zoneId}] push setpoints -> HSP=${hF}°F CSP=${cF}°F`);
  return this.platform.client.setZoneSetpoints(this.zoneId, { hsp: hF, csp: cF, holdType: "temporary" });
}

  _currentState() {
    const C = this.Characteristic.CurrentHeatingCoolingState;
    if (this.mode === "heat") return C.HEAT;
    if (this.mode === "cool") return C.COOL;
    return C.OFF; // for "heat and cool" we report OFF without tempOperation info
  }

  // Called with S40 status (temps in °F)
  applyZoneStatus(s) {
    if (!s) return;
    const p = s.period || {};
    this.log(`[Zone ${this.zoneId}] raw: temp=${s.temperature}°F, hsp=${p.hsp}°F, csp=${p.csp}°F, mode=${p.systemMode}`);

    if (typeof s.temperature === "number") this.tempC = f2c(s.temperature);
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