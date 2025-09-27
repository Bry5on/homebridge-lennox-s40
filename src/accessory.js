// src/accessory.js

const MODE_TO_HOMEKIT = {
  "off": 0,           // Characteristic.TargetHeatingCoolingState.OFF
  "heat": 1,          // ...HEAT
  "cool": 2,          // ...COOL
  "heat and cool": 3, // ...AUTO
};
const HOMEKIT_TO_MODE = ["off", "heat", "cool", "heat and cool"];

/**
 * Represents one Lennox S40 zone as a HomeKit Thermostat (+ Humidity).
 *
 * Expected platform contract:
 *   - platform.log           : logger
 *   - platform.Service       : HAP Service
 *   - platform.Characteristic: HAP Characteristic
 *   - platform.client        : has .command(body) to talk to the S40
 *
 * index.js should:
 *   - new LennoxZoneAccessory(platform, accessory, zoneId)
 *   - call .applyZoneStatus(status) as updates arrive
 */
class LennoxZoneAccessory {
  constructor(platform, accessory, zoneId) {
    this.platform  = platform;
    this.log       = platform.log;
    this.accessory = accessory;
    this.zoneId    = zoneId;

    this.name = `Lennox Zone ${zoneId}`;

    // --- cached state (Celsius in cache to match HAP) ---
    this.curTempC = 21;   // default 70°F
    this.hspC     = 20;   // ~68°F
    this.cspC     = 23;   // ~73°F
    this.humidity = 50;
    this.currentOperation = "off";        // "heating" | "cooling" | "off"
    this.targetMode       = "heat and cool";

    // ---------- Services ----------
    const { Service, Characteristic } = this.platform;

    this.thermo = this.accessory.getService(Service.Thermostat)
      || this.accessory.addService(Service.Thermostat, this.name);

    // Cosmetic: show °F in the Home app (HAP values still stay °C)
    this.thermo.updateCharacteristic(Characteristic.TemperatureDisplayUnits, 1); // 0=C, 1=F

    // Threshold characteristics are °C in HAP
    this.thermo.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 35, minStep: 0.5 })
      .onGet(() => this.cspC)
      .onSet(v => this.setCoolC(v));

    this.thermo.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 0, maxValue: 25, minStep: 0.5 })
      .onGet(() => this.hspC)
      .onSet(v => this.setHeatC(v));

    this.thermo.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.curTempC);

    this.thermo.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.mapCurrentState(this.currentOperation));

    this.thermo.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => MODE_TO_HOMEKIT[this.targetMode] ?? 0)
      .onSet(v => this.setMode(HOMEKIT_TO_MODE[v] ?? "off"));

    // Humidity service (optional but nice)
    this.humidSvc = this.accessory.getService(Service.HumiditySensor)
      || this.accessory.addService(Service.HumiditySensor, `${this.name} Humidity`);
    this.humidSvc.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.humidity);

    // Accessory Info (avoid empty serials)
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Lennox")
      .setCharacteristic(Characteristic.Model, "S40")
      .setCharacteristic(Characteristic.SerialNumber, String(this.zoneId ?? "S40-0"));
  }

  // ---------- Public: feed cloud/LAN status into HomeKit ----------
  /**
   * status sample (from LAN):
   * {
   *   temperatureC: 23, temperature: 73, humidity: 66,
   *   tempOperation: "off"|"heating"|"cooling",
   *   period: { systemMode: "heat and cool", hspC: 20.5, cspC: 23, ... }
   * }
   */
  applyZoneStatus(status) {
    const { Characteristic } = this.platform;

    // Current temp (prefer °C, else convert from °F if provided)
    const cC = this.pickNumber(
      status?.temperatureC,
      this.fromF(status?.temperature)
    );
    if (Number.isFinite(cC)) {
      this.curTempC = cC;
      this.thermo.updateCharacteristic(Characteristic.CurrentTemperature, this.curTempC);
    }

    // Current op -> CurrentHeatingCoolingState
    if (typeof status?.tempOperation === "string") {
      this.currentOperation = status.tempOperation;
      this.thermo.updateCharacteristic(
        Characteristic.CurrentHeatingCoolingState,
        this.mapCurrentState(this.currentOperation)
      );
    }

    // Target mode from period.systemMode
    const maybeMode = status?.period?.systemMode;
    if (typeof maybeMode === "string") {
      this.targetMode = maybeMode;
      this.thermo.updateCharacteristic(
        Characteristic.TargetHeatingCoolingState,
        MODE_TO_HOMEKIT[this.targetMode] ?? 0
      );
    }

    // Setpoints (prefer °C, else convert from °F)
    const hC = this.pickNumber(status?.period?.hspC, this.fromF(status?.period?.hsp));
    const cC = this.pickNumber(status?.period?.cspC, this.fromF(status?.period?.csp));

    if (Number.isFinite(hC)) {
      this.hspC = this.clamp(hC, 0, 25);
      this.thermo.updateCharacteristic(Characteristic.HeatingThresholdTemperature, this.hspC);
    }
    if (Number.isFinite(cC)) {
      this.cspC = this.clamp(cC, 10, 35);
      this.thermo.updateCharacteristic(Characteristic.CoolingThresholdTemperature, this.cspC);
    }

    // Humidity
    if (Number.isFinite(status?.humidity)) {
      this.humidity = status.humidity;
      this.humidSvc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, this.humidity);
    }
  }

  // ---------- Setters (HomeKit -> S40) ----------
  async setMode(mode) {
    try {
      this.targetMode = mode;
      await this.sendPeriod({ systemMode: mode });
      // update cached Target on success
      this.thermo.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState,
        MODE_TO_HOMEKIT[this.targetMode] ?? 0
      );
    } catch (e) {
      this.log.error("[Lennox Zone %s] setMode error: %s", this.zoneId, e?.message || e);
      throw e;
    }
  }

  async setHeatC(vC) {
    try {
      const clamped = this.clamp(vC, 0, 25);
      await this.sendPeriod({ hspC: clamped });
      this.hspC = clamped;
      this.thermo.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.hspC);
    } catch (e) {
      this.log.error("[Lennox Zone %s] setHeatC error: %s", this.zoneId, e?.message || e);
      throw e;
    }
  }

  async setCoolC(vC) {
    try {
      const clamped = this.clamp(vC, 10, 35);
      await this.sendPeriod({ cspC: clamped });
      this.cspC = clamped;
      this.thermo.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.cspC);
    } catch (e) {
      this.log.error("[Lennox Zone %s] setCoolC error: %s", this.zoneId, e?.message || e);
      throw e;
    }
  }

  // ---------- Wire-up to your platform client ----------
  async sendPeriod(partial) {
    // S40 LAN write schema: zones -> [{ id, status: { period: {...} } }]
    const body = {
      zones: [
        { id: this.zoneId, status: { period: { ...partial } } }
      ]
    };
    if (!this.platform?.client?.command) {
      throw new Error("platform.client.command not available");
    }
    this.platform.log.debug("[Lennox Zone %s] WRITE %j", this.zoneId, body);
    await this.platform.client.command(body);
  }

  // ---------- Helpers ----------
  mapCurrentState(tempOperation) {
    const { Characteristic } = this.platform;
    if (tempOperation === "heating") return Characteristic.CurrentHeatingCoolingState.HEAT;
    if (tempOperation === "cooling") return Characteristic.CurrentHeatingCoolingState.COOL;
    return Characteristic.CurrentHeatingCoolingState.OFF;
  }

  fromF(vF) {
    return (typeof vF === "number") ? (vF - 32) * 5 / 9 : undefined;
  }

  clamp(val, min, max) {
    if (!Number.isFinite(val)) return val;
    if (min !== undefined && val < min) val = min;
    if (max !== undefined && val > max) val = max;
    return Math.round(val * 10) / 10; // keep a tidy single decimal
  }

  pickNumber(...candidates) {
    for (const v of candidates) {
      if (Number.isFinite(v)) return v;
    }
    return undefined;
  }
}

module.exports = LennoxZoneAccessory;
