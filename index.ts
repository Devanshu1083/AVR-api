import '@wokwi/elements';
import { PinState } from 'avr8js';
import * as net from 'net';
import { buildHex } from './compile';
import { CPUPerformance } from './cpu-performance';
import { AVRRunner } from './execute';
import { formatTime } from './format-time';
import './index.css';
import { receiveMessageOnPort } from 'worker_threads';

const clientSockets = new Map();
function generateClientId() {
    return Math.random().toString(36).substring(2, 10);
}

let BLINK_CODE = `
// Green LED connected to LED_BUILTIN,
// Red LED connected to pin 12. Enjoy!

void setup() {
  Serial.begin(115200);
  pinMode(11, OUTPUT);
}

byte brightness = 0;
void loop() {
  analogWrite(11, brightness);
  delay(20);
  brightness++;
}`.trim();

let runner: AVRRunner;
let led11value = false;
let led11 = 0;
let led12 = false;
let led13 = true;
//digital read and write pins
let digitalPins : number[] = new Array(14).fill(0);
//pwm on  3,5,6,9,10,11 analogwrite
const PWMindices : number[] = [3,5,6,9,10,11];
//analog read pins
let AnalogPins : number[] = new Array(6).fill(0);


function executeProgram(hex: string) {
  runner = new AVRRunner(hex);
  const MHZ = 16000000;

  let lastState : number[] = new Array(14).fill(PinState.Input);
  let lastStateCycles : number[] = new Array(14).fill(0);
  let lastUpdateCycles : number[] = new Array(14).fill(0);
  let ledHighCycles : number[] = new Array(14).fill(0);

  // Hook to PORTB register
  runner.portB.addListener((value) => {
    led12 = runner.portB.pinState(4) === PinState.High;
    led13 = runner.portB.pinState(5) === PinState.High;

    for(const i of PWMindices){
      if(i<8){
        const pinState = runner.portB.pinState(i);
        if (lastState[i] !== pinState) {
          const delta = runner.cpu.cycles - lastStateCycles[i];
          if (lastState[i] === PinState.High) {
            ledHighCycles[i] += delta;
          }
          lastState[i] = pinState;
          lastStateCycles[i] = runner.cpu.cycles;
        }
      }else{
        const pinState = runner.portD.pinState(i-8);
        if (lastState[i] !== pinState) {
          const delta = runner.cpu.cycles - lastStateCycles[i];
          if (lastState[i] === PinState.High) {
            ledHighCycles[i] += delta;
          }
          lastState[i] = pinState;
          lastStateCycles[i] = runner.cpu.cycles;
        }
      }
    }
  });

  const cpuPerf = new CPUPerformance(runner.cpu, MHZ);
  runner.execute((cpu) => {
    const time = formatTime(cpu.cycles / MHZ);
    const speed = (cpuPerf.update() * 100).toFixed(0);
    
    //digital read values
    const digRead: number[] = new Array(14).fill(0);

    //digital write
    for (let i = 0; i < digitalPins.length; i++) {
      if(i<8){
        digitalPins[i] = (runner.portB.pinState(i) === PinState.High)? 1024 : 0;
      }else{
        digitalPins[i] = (runner.portD.pinState(i-8) === PinState.High)? 1024 : 0;
      }
    }
    //digital read
    for (let i = 0; i < digitalPins.length; i++) {
      if(i<8 &&((runner.portB.pinState(i) !== PinState.High) && (runner.portB.pinState(i) !== PinState.Low))){
        runner.portB.setPin(i, digRead[i]!==0 ? PinState.High : PinState.Low);
      }else if(i>7 &&((runner.portB.pinState(i-8) !== PinState.High) && (runner.portB.pinState(i-8) !== PinState.Low))){
        runner.portD.setPin(i-8, digRead[i]!==0 ? PinState.High : PinState.Low);
      }
    }
    //analogWrite
    for (const i of PWMindices) {
      if(i<8){
         const cyclesSinceUpdate = cpu.cycles - lastUpdateCycles[i];
         const pinState = runner.portB.pinState(i);
         if (pinState === PinState.High) {
             ledHighCycles[i] += cpu.cycles - lastStateCycles[i];
         }
         digitalPins[i] = ledHighCycles[i] / cyclesSinceUpdate;
         lastUpdateCycles[i] = cpu.cycles;
         lastStateCycles[i] = cpu.cycles;
         ledHighCycles[i] = 0;
      }else{
         const cyclesSinceUpdate = cpu.cycles - lastUpdateCycles[i];
         const pinState = runner.portB.pinState(i-8);
         if (pinState === PinState.High) {
             ledHighCycles[i-8] += cpu.cycles - lastStateCycles[i-8];
         }
         digitalPins[i-8] = ledHighCycles[i-8] / cyclesSinceUpdate;
         lastUpdateCycles[i-8] = cpu.cycles;
         lastStateCycles[i-8] = cpu.cycles;
         ledHighCycles[i-8] = 0;
      }
    }
    //Ananlog Read

  });
}

async function compileAndRun() {
  try {
    const result = await buildHex(BLINK_CODE);
    if (result.hex) {
      executeProgram(result.hex);
    } else {
    }
  } catch (err) {
  } finally {
  }
}
function stopCode() {
  if (runner) {
    runner.stop();
    runner = null;
  }
}

const port: number = 3000;

const server: net.Server = net.createServer((socket: net.Socket) => {
    console.log('Client connected');

    // Handle incoming data
    socket.on('data', (data: Buffer) => {
        const receivedData: string = data.toString().trim();
        if(receivedData === 'start'){
          compileAndRun();
        }else if(receivedData==='stop'){
          stopCode();
        }else if(receivedData==='readState'){
          const jsonDigitalPins = JSON.stringify(digitalPins);
          socket.write(jsonDigitalPins);
        }
        console.log('Received data:', receivedData);
        // Handle the received data if needed
    });

    // Handle client disconnection
    socket.on('end', () => {
        console.log('Client disconnected');
    });
});

server.on("connection", (socket) => { 
  console.log("new client connection is made", socket.remoteAddress + ":" + socket.remotePort); 
  // Handle incoming data
  socket.on('data', (data: Buffer) => {
    const receivedData: string = data.toString().trim();
    if(receivedData === 'start'){
      compileAndRun();
    }else if(receivedData==='stop'){
      stopCode();
    }else if(receivedData==='readState'){
      const jsonDigitalPins = JSON.stringify(digitalPins);
      socket.write(jsonDigitalPins);
    }
    console.log('Received data:', receivedData);
    // Handle the received data if needed
  });

  // Handle client disconnection
  socket.on('end', () => {
    console.log('Client disconnected');
  });
  socket.once("close", () => { 
    console.log("client connection closed."); 
  }); 
  socket.on("error", (err) => { 
    console.log("client connection got errored out.") 
  }); 
  socket.write('SERVER: Hello! Connection successfully made.<br>'); 
}); 
server.listen(port, () => {
    console.log(`Server listening on  ${server.address()}`);
    console.log(`opened server on port ${port}`); 
});





