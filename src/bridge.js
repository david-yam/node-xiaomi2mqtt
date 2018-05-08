const log = require('yalm')
const config = require('./config.js')
const mqtt = require('mqtt')
const Aqara = require('lumi-aqara')
const pkg = require('../package.json')
const fs = require('fs')

let mqttClient
let aqara
let devices
let gateways = []

function start () {
  log.setLevel(config.logging)
  log._info(pkg.name + ' ' + pkg.version + ' starting')

  if (config.devices) {
    fs.access(config.devices, fs.constants.R_OK, (err) => {
      if (!err) {
        log.info('Loading devices from: ' + config.devices)
        try {
          devices = require(config.devices)
        } catch (e) {
          log.error('Error loading devices: ', e)
        }
      }
    })
  }

  const mqttOptions = {
    will: {
      topic: config.name + '/connected',
      message: 0,
      qos: 0,
      retain: true
    },
    rejectUnauthorized: !config.insecure
  }

  mqttClient = mqtt.connect(config.mqtt, mqttOptions)

  mqttClient.on('connect', () => {
    log.info('Connected to MQTT: %s', config.mqtt)
    publishConnectionStatus()
    mqttClient.subscribe(config.name + '/set/+/light')
  })

  mqttClient.on('message', (topic, message) => {
    const parts = topic.split('/')
    if (parts[1] === 'set' && parts[3] === 'light') {
      const gateway = gateways[parts[2]]
      if (gateway) {
        handleGatewayLightUpdate(gateway, message)
      }
    }
  })

  mqttClient.on('close', () => {
    log.info('mqtt closed ' + config.mqtt)
  })

  mqttClient.on('error', err => {
    log.error('mqtt', err.toString())
  })

  mqttClient.on('offline', () => {
    log.error('mqtt offline')
  })

  mqttClient.on('reconnect', () => {
    log.info('mqtt reconnect')
  })

  aqara = new Aqara()
  aqara.on('gateway', (gateway) => {
    log.info('Gateway discovered')

    gateway.on('ready', () => {
      log.info('Gateway %s ready', gateway._sid)
      gateways[gateway._sid] = gateway
      publishConnectionStatus()
      if (devices && devices.gateways && devices.gateways[gateway._sid]) {
        gateway.setPassword(devices.gateways[gateway._sid])
      } else if (config.password) {
        gateway.setPassword(config.password)
      }
    })

    gateway.on('offline', () => {
      delete gateways[gateway._sid]
      log.warn('Gateway is offline')
      publishConnectionStatus()
    })

    gateway.on('subdevice', (device) => {
      log.debug(`Device found: ${device.getSid()} (${device.getType()}) name: ${getFriendlyName(device.getSid())}`)

      switch (device.getType()) {
        case 'magnet':
          publishMagnetState(device, `${device.isOpen() ? 'open' : 'closed'}`)
          device.on('open', () => {
            publishMagnetState(device, 'open')
          })
          device.on('close', () => {
            publishMagnetState(device, 'closed')
          })
          break
        case 'switch':
          publishDeviceData(device, 'unknown')
          device.on('click', () => {
            publishDeviceData(device, '0')
          })
          device.on('doubleClick', () => {
            publishDeviceData(device, '1')
          })
          device.on('longClickPress', () => {
            publishDeviceData(device, '2')
          })
          device.on('longClickRelease', () => {
            //publishDeviceData(device, 'released')
          })
          break
        case 'motion':
          publishDeviceData(device, `${device.hasMotion() ? 'motion' : 'no_motion'}`, {lux: device.getLux()})
          device.on('motion', () => {
            publishDeviceData(device, 'motion', {lux: device.getLux()})
          })
          device.on('noMotion', () => {
            publishDeviceData(device, 'no_motion', { secondsSinceMotion: device.getSecondsSinceMotion(), lux: device.getLux() })
          })
          break
        case 'sensor':
          publishHTSensor(device)
          device.on('update', () => {
            publishHTSensor(device)
          })
          break
        case 'leak':
          publishDeviceData(device, `(${device.isLeaking() ? 'leaking' : 'not_leaking'})`)
          device.on('update', () => {
            publishDeviceData(device, `(${device.isLeaking() ? 'leaking' : 'not_leaking'})`)
          })
          break
        case 'cube':
          publishDeviceData(device, 'unknown')
          device.on('update', () => {
            publishDeviceData(device, device.getStatus(), {rotation: device.getRotateDegrees()})
          })
          break
      }
    })

    gateway.on('lightState', (state) => {
      log.info(`Light updated: ${JSON.stringify(state)}`)
      const data = {
        state: state,
        ts: Date.now()
      }
      const sid = gateway._sid
      mqttClient.publish(`${config.name}/status/light/${sid}`,
        JSON.stringify(data),
        {qos: 0, retain: true})
    })
  })
}

function handleGatewayLightUpdate (gateway, message) {
  if (!gateway) return
  // TODO send message to gateway.
  log.info('Updating gateway light')
  if (IsNumeric(message)) {
    var value = parseInt(message)
    if (value >= 0 && value <= 100) {
      gateway.setIntensity(value)
    } else {
      log.warn(`Value: ${value} not valid intensity!`)
    }
  } else { // Not numeric
    const data = JSON.parse(message)
    // TODO do something with the data.
    gateway.setIntensity(data.intensity)
    gateway.setColor(data.color)
  }
}

function publishConnectionStatus () {
  var status = '1'
  if (gateways.length > 0) { status = '2' }
  mqttClient.publish(config.name + '/connected', status, {
    qos: 0,
    retain: true
  })
}

function publishDeviceData (device, newState, extraData = {}) {
  /*
  let data = {
    val: newState, // Using val according to the MQTT Smarthome specs.
    battery: device.getBatteryPercentage(),
    name: getFriendlyName(device.getSid()),
    ts: Date.now()
  }*/

  var name = device.getSid()
  if (getFriendlyName(device.getSid()) !== null) {  
    name = getFriendlyName(device.getSid())
  }

  //Object.assign(data, extraData)
  var topic = `${config.name}/${name}/status`
  log.info(`Publishing ${newState} to ${topic}`)
  mqttClient.publish(topic,
    newState,
    {qos: 0, retain: true}
  )
}

let magnets = []
function publishMagnetState (device, newState) {
  const magnetIndex = magnets.findIndex(function (m) { return m.id === device.getSid() })

  if (magnetIndex > -1) {
    if (magnets[magnetIndex].state === newState) {
      return
    } else {
      magnets[magnetIndex].state = newState
    }
  } else {
    magnets.push({id: device.getSid(), state: newState})
  }
  publishDeviceData(device, newState)
}

function publishHTSensor (sensorDevice) {
  var name = sensorDevice.getSid()
  if (getFriendlyName(sensorDevice.getSid()) !== null) {  
    name = getFriendlyName(sensorDevice.getSid())
  }

  const tempTopic = `${config.name}/${name}/temperature`
  const humTopic = `${config.name}/${name}/humidity`
  const presTopic = `${config.name}/${name}/pressure`
  const batteryTopic = `${config.name}/${name}/battery/status`
  /*
  let data = {
    val: sensorDevice.getTemperature(),
    battery: sensorDevice.getBatteryPercentage(),
    name: getFriendlyName(sensorDevice.getSid()),
    ts: Date.now()
  }*/
  mqttClient.publish(tempTopic,
    sensorDevice.getTemperature(),
    {qos: 0, retain: true}
  )
  data.val = 
  mqttClient.publish(humTopic,
    sensorDevice.getHumidity(),
    {qos: 0, retain: true}
  )

  let pressure = sensorDevice.getPressure()
  if (pressure !== null) {
    mqttClient.publish(presTopic,
      pressure,
      {qos: 0, retain: true}
    )
  }

  if(sensorDevice.getBatteryPercentage() < 10){
    mqttClient.publish(batteryTopic,
      1,
      {qos: 0, retain: true}
    )
  }
}

// Usefull function
function IsNumeric (val) {
  return Number(parseFloat(val)) === val
}

function getFriendlyName (deviceId) {
  if (devices && devices[deviceId]) {
    return devices[deviceId]
  }
  return null
}

start()
