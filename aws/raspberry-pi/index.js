const five = require('johnny-five');
const moment = require('moment-timezone');
const iot = require('aws-iot-device-sdk');
const Io = require('raspi-io');
const RaspiCam = require('raspicam');
const fs = require('fs');
const path = require('path');

const AWS = require('aws-sdk');
const s3 = new AWS.S3();

// AWS IoT Device configuration
const device = iot.device({
  keyPath: __dirname + '/keys/private.pem.key',
  certPath: __dirname + '/keys/certificate.pem.crt',
  caPath: __dirname + '/keys/root-CA.pem.crt',
  clientId: process.env.AWS_IOT_CLIENTID || 'raspberry-kitty',
  region: process.env.AWS_REGION || 'us-east-1'
});

// Raspberry Pi Camera configuration
const camera = new RaspiCam({
  mode: 'photo',
  output: './tmp/cat.jpg',
  encoding: 'jpg',
	timeout: 0 // take the picture immediately
});
const board = new five.Board({
  io: new Io()
});

board.on('ready', () => {
  const motion = new five.Motion({
    pin: 'P1-7', //PIR is wired to pin 7 (GPIO 4)
    freq: 100
  });

  // if the camera doesn't exist, don't bother trying to take or upload photo
  if (camera) {
    camera.on('start', (err, timestamp) => {
      console.log('Camera is taking a photo!');
    });

    camera.on('exit', (timestamp) => {
      console.log('Camera is exiting');
    });

    // listen for the "read" event triggered when each new photo/video is saved
    camera.on('read', (err, timestamp, filename) => {
      camera.stop();
      console.log('Image saved with filename:', filename);

      // read the file from the `/tmp` directory
      fs.readFile(`./tmp/${filename}`, (err, data) => {
        if (err) {
          console.log('Problem reading file', err);
          throw err;
        }

        const timestamp = moment().valueOf();
        const newFileName = `${path.parse(filename).name}-${timestamp}${path.parse(filename).ext}`;

        const params = {
          Bucket: 'kitty-detections',
          Key: newFileName,
          Body: data, // file buffer
          ContentType: 'image/jpeg',
          ACL: 'public-read' // this is temporary fix
        };

        s3.putObject(params, (err, data) => {
          if (err) {
            console.log('Problem uploading image', err);
            throw err;
          }

          // Successful
          console.log('Image successfully uploaded', data);
          const imageUrl = `https://s3.amazonaws.com/${params.Bucket}/${params.Key}`;
          console.log(imageUrl);
          const detectionObj = {
            'motion': true,
            'timestamp': moment().tz('America/New_York').format('LLL'),
            'imageUrl': imageUrl,
            's3': {
              'bucket': params.Bucket,
              'image': params.Key
            }
          };

          // send data about this detection to AWS IoT
          device.publish('kitty-detection', JSON.stringify(detectionObj));
        });
      });
    });
  }

  // This happens once at the begnning of the session. The default state.
  motion.on('calibrated', () => {
    console.log('Motion detector calibrated and ready');
  });

  motion.on('motionstart', data => {
    const now = moment().tz('America/New_York').format('LLL');
    console.log(`Motion Alert: something was spotted at: ${now}`);
    if (camera) {
      // take a photo
      camera.start();
    } else {
      // if there isn't a camera, send the sns message
      device.publish('kitty-detection', JSON.stringify({'motion': true, 'timestamp': now}));
    }
  });

  motion.on('motionend', () => {
    console.log('Motion has stopped for 100ms');
  });
});

device.on('connect', () => {
  console.log('Connecting to Amazon IoT');
});

device.on('message', (topic, payload) => {
  console.log('Your messaged was received by Amazon IoT:', topic, payload);
});

device.on('close', () => {
  // do nothing
});

device.on('reconnect', () => {
  console.log('Attempting to reconnect to Amazon IoT');
});

device.on('error', err => {
  console.log(`Error: ${err.code} while connecting to ${err.hostname}`);
});

device.on('offline', () => {
  // do nothing
});
