// ONE DOLLAR 2050 SOUND ENGINE
// No external audio files needed. Sounds are generated in the browser.
window.OD_SOUND_ON = localStorage.getItem("od_sound") !== "off";

const OD_SFX = {
  ctx: null,
  init(){
    if(!this.ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(AC) this.ctx = new AC();
    }
    if(this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },
  tone(freq, duration=.08, type="sine", volume=.05, delay=0){
    if(!window.OD_SOUND_ON) return;
    this.init(); if(!this.ctx) return;
    const t=this.ctx.currentTime+delay, o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type=type;o.frequency.setValueAtTime(freq,t);
    g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(volume,t+.01);
    g.gain.exponentialRampToValueAtTime(0.0001,t+duration);
    o.connect(g);g.connect(this.ctx.destination);o.start(t);o.stop(t+duration+.02);
  },
  click(){this.tone(210,.045,"square",.035);this.tone(420,.06,"sine",.025,.035)},
  push(){this.tone(140,.06,"triangle",.06);this.tone(280,.08,"sine",.035,.04)},
  success(){this.tone(523,.08,"sine",.06);this.tone(659,.08,"sine",.06,.09);this.tone(784,.14,"sine",.07,.18)},
  coin(){this.tone(1200,.05,"sine",.06);this.tone(1700,.12,"sine",.05,.06)},
  error(){this.tone(180,.15,"sawtooth",.045);this.tone(120,.18,"sawtooth",.03,.08)},
  notification(){this.tone(740,.08,"sine",.05);this.tone(980,.12,"sine",.045,.11)}
};

document.addEventListener("pointerdown",e=>{
  const el=e.target.closest("button");
  if(el && !el.classList.contains("sound-toggle")) OD_SFX.click();
},{passive:true});

document.addEventListener("DOMContentLoaded",()=>{
  document.querySelectorAll("button").forEach(b=>{
    b.addEventListener("pointerdown",()=>{ if(!b.classList.contains("sound-toggle")) OD_SFX.push(); });
  });
  const toggle=document.querySelector(".sound-toggle");
  if(toggle){
    toggle.textContent=window.OD_SOUND_ON?"🔊":"🔇";
    toggle.onclick=()=>{window.OD_SOUND_ON=!window.OD_SOUND_ON;localStorage.setItem("od_sound",window.OD_SOUND_ON?"on":"off");toggle.textContent=window.OD_SOUND_ON?"🔊":"🔇";if(window.OD_SOUND_ON)OD_SFX.notification();};
  }
});
