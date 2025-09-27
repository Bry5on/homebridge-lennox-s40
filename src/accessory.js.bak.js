const { Service, Characteristic } = require("homebridge");

const MODE_TO_HOMEKIT = {
  "off": 0,
  "heat": 1,
  "cool": 2,
  "heat and cool": 3
};
const HOMEKIT_TO_MODE = ["off","heat","cool","heat and cool"];

class LennoxZoneAccessory {
  constructor(platform, zoneId) {
    this.platform = platform;
    this.zoneId = zoneId;
    this.name = `Lennox Zone ${zoneId}`;
    this.log = platform.log;

    this.temperature = 72;
    this.humidity = 50;
    this.mode = "heat and cool";
    this.hsp = 69;
    this.csp = 73;

    const uuid = platform.api.hap.uuid.generate(`${platform.host}-${zoneId}`);
    this.accessory = new platform.api.platformAccessory(this.name, uuid);

    this.service = this.accessory.getService(Service.Thermostat) || this.accessory.addService(Service.Thermostat, this.name);

    // Required characteristics
    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => MODE_TO_HOMEKIT[this.mode] ?? 0);

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [0,1,2,3] })
      .onGet(() => MODE_TO_HOMEKIT[this.mode] ?? 0)
      .onSet(async (value) => {
        const mode = HOMEKIT_TO_MODE[value] || "off";
        await this.platform.client.setZoneMode(this.zoneId, mode);
        this.mode = mode;
        this.log(`Zone ${this.zoneId}: set mode -> ${mode}`);
      });

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.temperature);

    // HomeKit Thermostat in Auto uses threshold temps
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 60, maxValue: 90, minStep: 1 })
      .onGet(() => this.csp)
      .onSet(async (value) => {
        await this.platform.client.setZoneSetpoints(this.zoneId, { csp: Math.round(value) });
        this.csp = Math.round(value);
        this.log(`Zone ${this.zoneId}: set csp -> ${this.csp}`);
      });

    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 50, maxValue: 85, minStep: 1 })
      .onGet(() => this.hsp)
      .onSet(async (value) => {
        await this.platform.client.setZoneSetpoints(this.zoneId, { hsp: Math.round(value) });
        this.hsp = Math.round(value);
        this.log(`Zone ${this.zoneId}: set hsp -> ${this.hsp}`);
      });

    // Optional: Relative Humidity service
    const humidSvc = this.accessory.getService(Service.HumiditySensor) || this.accessory.addService(Service.HumiditySensor, `${this.name} Humidity`);
    humidSvc.getCharacteristic(Characteristic.CurrentRelativeHumidity).onGet(() => this.humidity);

    // Accessory information
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Lennox")
      .setCharacteristic(Characteristic.Model, "S40")
      .setCharacteristic(Characteristic.SerialNumber, String(zoneId));

    platform.api.registerPlatformAccessories("homebridge-lennox-s40", "LennoxS40Platform", [this.accessory]);
  }

  // Update from bus message
  applyZoneStatus(status) {
    if (!status) return;
    if (typeof status.temperature === "number") this.temperature = status.temperature;
    if (typeof status.humidity === "number") this.humidity = status.humidity;

    const period = status.period || {};
    if (typeof period.hsp === "number") this.hsp = period.hsp;
    if (typeof period.csp === "number") this.csp = period.csp;
    if (typeof period.systemMode === "string") this.mode = period.systemMode;

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.temperature);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, MODE_TO_HOMEKIT[this.mode] ?? 0);
    this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.csp);
    this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.hsp);

    const humidSvc = this.accessory.getService(this.platform.Service.HumiditySensor);
    if (humidSvc) humidSvc.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.humidity);
  }
}

module.exports = { LennoxZoneAccessory };
