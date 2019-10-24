const { smarthome } = require("actions-on-google");

const config = require("../config/index");
// check config
if (!config.iotery.teamApiKey) {
  console.error("You need to provide IOTERY_TEAM_API_KEY as an ENV");
}
if (!config.homeGraphApiKey) {
  console.error("You need to provide HOMEGRAPH_API_KEY as an ENV");
}

const iotery = require("iotery-server-sdk")(config.iotery.teamApiKey, {
  baseUrl: config.iotery.baseApiUrl
});

const uuid = require("uuid");

// cache
let isUserLinked = true;

const app = smarthome({
  key: config.homeGraphApiKey,
  jwt: require("./google-action-key.json")
});
module.exports.fulfill = app;

// SYNC intent
app.onSync(async (body, headers) => {
  console.log("SYNC intent");
  isUserLinked = true;

  const userId = config.userId;
  const deviceId = config.deviceId;

  const res = await iotery.getDevice({
    deviceUuid: deviceId
  });

  const device = {
    id: deviceId,
    type: "action.devices.types.LIGHT",
    traits: ["action.devices.traits.OnOff"],
    willReportState: false,
    name: {
      defaultNames: [res.name],
      name: res.name,
      nicknames: [res.name]
    }
  };

  // report state to HomeGraph
  const onOffState = await _getLightOnOffState(deviceId);
  _reportLightOnOffState(deviceId, onOffState);

  return {
    requestId: body.requestId,
    payload: {
      agentUserId: userId,
      devices: [device]
    }
  };
});

// DISCONNECT intent
app.onDisconnect((body, headers) => {
  console.log("DISCONNECT intent");
  isUserLinked = false;
  if (!isUserLinked) {
    console.log("UNLINKED");
  }
});

// EXECUTE intent
app.onExecute(async (body, headers) => {
  console.log("EXECUTE");
  const commands = [{ ids: [], status: "", states: { on: null } }];

  for (const input of body.inputs) {
    for (const command of input.payload.commands) {
      for (const device of command.devices) {
        for (const exec of command.execution) {
          commands[0].ids.push(device.id);

          let turnOn = null;
          if (exec.command === "action.devices.commands.OnOff") {
            turnOn = exec.params.on;
          }

          // send out command to device
          if (turnOn !== null) {
            commands[0].states.on = turnOn;
            try {
              await _actuateLight({
                deviceId: device.id,
                turnOn
              });
              commands[0].status = "SUCCESS";
            } catch (err) {
              commands[0].status = "ERROR";
            }

            // report state to HomeGraph
            const onOffState = await _getLightOnOffState(device.id);
            _reportLightOnOffState(device.id, onOffState);
          }
        }
      }
    }
  }

  return {
    requestId: body.requestId,
    payload: { commands }
  };
});

// QUERY intent
app.onQuery(async (body, headers) => {
  console.log("QUERY");
  const devices = {};

  for (const input of body.inputs) {
    for (const device of input.payload.devices) {
      const on = await _getLightOnOffState(device.id);
      devices[device.id] = { on };

      // report state to Home Graph
      _reportLightOnOffState(device.id, on);
    }
  }

  return {
    requestId: body.requestId,
    payload: { devices }
  };
});

// Webhook Handler: Request Sync
module.exports.handleDeviceUpdate = async (req, res, next) => {
  console.log("WEBHOOK: /update-device");
  const ioteryEnum = req.body.metadata.webhookInfo.enum;
  const deviceUuid = req.body.out.uuid;

  if (
    ioteryEnum === "ACCOUNT_MANAGER_UPDATE_DEVICE" &&
    deviceUuid === config.deviceId
  ) {
    const userId = config.userId;
    // only send out request sync if account is linked
    if (isUserLinked) {
      app
        .requestSync(userId)
        .then(res => {
          console.log("Request sync successful");
          console.log(res);
        })
        .catch(err => {
          console.error("Request sync failed");
          console.error(err);
        });
    }
  }

  res.json({ status: "received" });
};

// Webhook Handler: Report State
module.exports.handleDeviceData = async (req, res, next) => {
  console.log("WEBHOOK: /device-data");
  const ioteryEnum = req.body.metadata.webhookInfo.enum;
  const { packets } = req.body.in;

  if (ioteryEnum === "EMBEDDED_POST_DATA") {
    packets.map(async p => {
      if (
        p.deviceUuid === config.iotery.deviceUuid &&
        p.data["IOTERY_ON_OFF_STATE"] !== undefined
      ) {
        const onOffState = p.data["IOTERY_ON_OFF_STATE"] === 1;
        _reportLightOnOffState(p.deviceUuid, onOffState);
      }
    });
  }
};

async function _actuateLight({ deviceId, turnOn }) {
  // get a list of the command types
  const commandTypeList = await iotery
    .getCommandTypeList({})
    .then(r => r.results);

  // get appropriate command type
  let commandType;
  if (turnOn) {
    commandType = commandTypeList.find(t => t.enum === "IOTERY_TURN_LIGHT_ON");
  } else {
    commandType = commandTypeList.find(t => t.enum === "IOTERY_TURN_LIGHT_OFF");
  }

  // send out command instance
  return iotery.createDeviceCommandInstance(
    { deviceUuid: deviceId },
    { commandTypeUuid: commandType.uuid }
  );
}

async function _getLightOnOffState(deviceId) {
  const data = await iotery
    .getDeviceDataList(
      { deviceUuid: deviceId },
      {
        query: { dataTypeEnum: "IOTERY_ON_OFF_STATE", limit: 1, order: "desc" }
      }
    )
    .then(r => r.results[0]);

  const onOffState = data ? data.value === 1 : false;
  console.log(`Device ${deviceId} is ${onOffState ? "ON" : "OFF"}`);
  return onOffState;
}

function _reportLightOnOffState(deviceUuid, onOffState) {
  const userId = config.userId;

  const payload = {
    devices: {
      states: {
        [deviceUuid]: {
          on: onOffState
        }
      }
    }
  };
  // Report State to AoG HomeGraph
  app
    .reportState({
      requestId: uuid.v4(),
      agentUserId: userId,
      payload
    })
    .then(res => {
      console.log("Successfully reported device state");
      console.log("On/Off state: ", onOffState ? "ON" : "OFF");
    })
    .catch(err => {
      console.error("There was an error reporting device state");
    });
}
