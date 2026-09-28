# homebridge-lennox-s40

Lennox S40 local LCC platform plugin. Not published to npm; install from this repo.

## Install / update in Homebridge

```bash
hb-service add homebridge-lennox-s40
# or, from the Homebridge machine:
npm install -g github:Bry5on/homebridge-lennox-s40
hb-service restart
```

In Homebridge UI: Plugins → the wrench → Install from URL → `https://github.com/Bry5on/homebridge-lennox-s40`.

Leave `resetOnBoot` off. UUIDs are `lennox-s40-zone:<id>` and are adopted across restarts.

## Mode writes

Home Off / Heat / Cool / Auto map to LCC `off` / `heat` / `cool` / `heat and cool`.

A mode change switches the zone onto manual schedule `16 + zoneId` and writes `period.systemMode` there, matching lennoxs30api. It also writes the mode onto the active hold schedule so a hold does not keep the old mode. It does not put the zone back on the programmed schedule. `emergency heat` displays as Heat; Home cannot select it.

## 0.3.0

- HomeKit target mode is written to the S40.
- Retrieve treats HTTP 204 as an empty poll, advances a timestamp cursor, and does not rewind that cursor on reconnect.
- Retrieve failure re-issues Connect, Endpoint Connect, and RequestData.
- Axios timeout is `max(20s, longPoll + 10s)`.
- Failed setpoint publishes are not treated as acknowledged.
