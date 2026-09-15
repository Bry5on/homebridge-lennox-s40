# homebridge-lennox-s40

Lennox S40 local LCC platform plugin.

## Child bridge

Already a `platform` plugin. Isolation is config, not code:

```json
{
  "platform": "LennoxS40Platform",
  "name": "Lennox S40",
  "host": "https://192.168.x.x",
  "zoneIds": [0],
  "resetOnBoot": false,
  "_bridge": {
    "username": "0E:XX:XX:XX:XX:01",
    "port": 55201,
    "pin": "XXX-XX-XXX",
    "name": "HB Lennox"
  }
}
```

Pair the child QR in Apple Home. Existing main-bridge tiles become ghosts; delete them.

## 0.2.0

- `resetOnBoot` defaults **false**. Cached accessories are adopted (`lennox-s40-zone:<id>`).
- Retrieve cursor advances when messages carry a timestamp field.
- On retrieve failure: Connect + Endpoint Connect + RequestData `/zones` before backoff.
- Axios timeout = max(20s, longPoll+10s); 204 treated as empty poll, not error.

`TargetHeatingCoolingState` writes are still a no-op.
