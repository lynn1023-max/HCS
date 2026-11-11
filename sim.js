const FPS = 30, END = 120 * FPS;
const names = ['轮式机器人', '四足机器狗', '固定云台'];
const roles = ['场外边线跟拍', '底线外低速跟拍', '高位全景'];
const dogLane = {x:17.5, near:1.6, far:6.4};
const colors = ['#39d8fb','#e5a4ff','#77f7aa'];
const phases = ['开球推进','半场传导','外线出手','篮板争抢','转换快攻','终场上篮'];
const $ = id => document.getElementById(id);
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const lerp = (a,b,t) => a+(b-a)*t;
const clock = frame => {
  const s = Math.floor(frame/FPS);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
};
function match(frame) {
  const t=frame/FPS, possession=Math.min(11,Math.floor(t/10)), u=clamp(t/10-possession,0,1);
  const dir=possession%2 ? -1 : 1;
  const x=dir*lerp(-10,9.6,Math.min(u/0.72,1));
  const z=2.5*Math.sin(u*6+possession);
  const players=Array.from({length:10},(_,i)=>{
    const lane=i%5, rival=i>=5;
    return [clamp(x+dir*(-lane*1.3+(rival?1.7:0))+0.4*Math.sin(t*2+i),-12.7,12.7),
      clamp(z+(lane-2)*2.2+(rival?0.8:0)-0.3*Math.cos(t*2+i),-6.8,6.8)];
  });
  players[0]=[x,z];
  const shot=clamp((u-0.72)/0.23,0,1);
  const ball=u<0.72?[x,0.48+0.6*Math.abs(Math.sin(t*11)),z]:
    [lerp(x,dir*12.4,shot),lerp(1.08,3.05,shot)+2.15*Math.sin(Math.PI*shot),lerp(z,0,shot)];
  const scores=[0,0];
  for(let p=0;p<=possession;p++) if(p<possession||u>=0.95) scores[p%2]+=p%3===2?3:2;
  return {players,ball,scores,dir,u};
}
const defaults={limit:4,threshold:0.55,occlusion:false,offline:false,stop:false};
let edits=[], history=[], frame=0, selected=0, programView=false, playing=false, carry=0;
function step(frame, prev, config) {
  const game=match(frame), [bx,,bz]=game.ball;
  const targets=[[clamp(bx,-12,12),11],[dogLane.x,game.dir<0?dogLane.far:dogLane.near],[0,-12]];
  const cameras=targets.map(([tx,tz],i)=>{
    const old=prev?.cameras[i], x=old?.x??tx, z=old?.z??tz;
    const distance=Math.hypot(tx-x,tz-z);
    const travel=i===2||config.stop||(i===1&&game.dir>0&&game.u>=0.72)?0:Math.min(distance,(i===1?Math.min(config.limit,0.45):config.limit)/FPS);
    const px=distance?lerp(x,tx,travel/distance):x, pz=distance?lerp(z,tz,travel/distance):z;
    const blocked=i===0&&config.occlusion, offline=i===2&&config.offline;
    const quality=offline?0:blocked?0.18:clamp(1-Math.hypot(bx-px,bz-pz)/48,0,1);
    const aim=quality>=config.threshold&&!offline?game.ball:old?.aim??[0,1,0];
    return {x:px,z:pz,y:[1.45,1.05,8][i],quality,blocked,offline,aim,velocity:travel*FPS};
  });
  const priority=game.u>=0.72&&game.dir===1?[1,0,2]:[0,2,1];
  const valid=i=>(i!==1||(game.dir>0&&game.u>=0.72))&&!cameras[i].offline&&!cameras[i].blocked&&cameras[i].quality>=config.threshold;
  const preferred=priority.find(valid)??-1;
  const active=prev&&prev.active>=0&&valid(prev.active)&&frame-prev.cut<45?prev.active:preferred;
  const cut=prev?.active===active?prev.cut:frame;
  return {game,cameras,active,cut,config};
}
function stateAt(target){
  for(let i=history.length;i<=target;i++){
    const prev=history[i-1], event=edits.find(e=>e.frame===i);
    history.push(step(i,prev,event?.config??prev?.config??defaults));
  }
  return history[target];
}
const overviewDefault={yaw:Math.atan2(19,30),pitch:Math.atan2(23,Math.hypot(19,30)),distance:Math.hypot(19,23,30)};
const overview={...overviewDefault};
function draw(canvas,state,index){
  const ctx=canvas.getContext('2d'), w=canvas.width,h=canvas.height;
  const camera=state.cameras[index];
  const eye=camera?[camera.x,camera.y,camera.z]:[
    overview.distance*Math.cos(overview.pitch)*Math.sin(overview.yaw),
    overview.distance*Math.sin(overview.pitch),
    overview.distance*Math.cos(overview.pitch)*Math.cos(overview.yaw)
  ];
  const aim=camera?camera.aim:[0,0,0];
  const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n)};
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const f=norm(aim.map((x,i)=>x-eye[i])), r=norm([-f[2],0,f[0]]);
  const up=[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]];
  const focal=w*(camera?0.79:1.04);
  function project(p){
    const d=p.map((x,i)=>x-eye[i]), z=dot(d,f);
    return z>0.3?[w/2+focal*dot(d,r)/z,h/2-focal*dot(d,up)/z,z]:null;
  }
  function shape(points,color,fill=false){
    const p=points.map(project);
    if(p.some(x=>!x))return;
    ctx.beginPath();p.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
    if(fill){ctx.closePath();ctx.fillStyle=color;ctx.fill()}else{ctx.strokeStyle=color;ctx.stroke()}
  }
  const rect=(a,b,c,d)=>[[a,0,b],[c,0,b],[c,0,d],[a,0,d]];
  const gradient=ctx.createLinearGradient(0,0,0,h);
  gradient.addColorStop(0,'#081020');gradient.addColorStop(1,'#253650');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
  if(camera?.offline){ctx.fillStyle='#ff8e98';ctx.font='bold '+w/20+'px system-ui';ctx.fillText('信号中断',w*.35,h*.52);return}
  if(index===-2){ctx.fillStyle='#ffc981';ctx.font='bold '+w/24+'px system-ui';ctx.fillText('暂无合格机位',w*.36,h*.52);return}
  // Tile the arena so a near-plane crossing only drops a small floor patch.
  for(let x=-20;x<20;x+=2) for(let z=-14;z<14;z+=2)
    shape(rect(x,z,x+2,z+2),(x+z)%4?'#192c46':'#1b304c',true);
  for(let x=-14;x<14;x+=0.5)for(let z=-7.5;z<7.5;z+=0.5)
    shape(rect(x,z,x+.5,z+.5),Math.round(x*2)%2?'#c89158':'#d29c61',true);
  const line='#fff1d9';
  function segments(points,color=line){for(let i=1;i<points.length;i++)shape([points[i-1],points[i]],color)}
  function ring(x,y,z,radius,a=0,b=2*Math.PI,color=line){
    segments(Array.from({length:49},(_,i)=>{const t=lerp(a,b,i/48);return [x+radius*Math.cos(t),y,z+radius*Math.sin(t)]}),color);
  }
  ctx.lineWidth=Math.max(1,w/520);
  segments([...rect(-14,-7.5,14,7.5),[-14,0,-7.5]]);
  segments([[0,0,-7.5],[0,0,7.5]]);ring(0,0,0,1.8);
  for(const s of [-1,1]){
    const key=rect(s*14,-2.45,s*8.2,2.45);shape(key,'#9f603d',true);segments([...key,key[0]]);
    ring(s*8.2,0,0,1.8);ring(s*12.4,0,0,6.6,s===1?1.67:-1.47,s===1?4.61:1.47);
    segments([[s*14,0,0],[s*14,3.7,0]],'#aac2dc');
    shape([[s*13,2.85,-.9],[s*13,3.9,-.9],[s*13,3.9,.9],[s*13,2.85,.9]],'#dbe7ef',true);
    ring(s*12.4,3.05,0,.24,0,2*Math.PI,'#ff602f');
  }
  if(index===-1){
    const zones=[rect(-12.7,10.3,12.7,11.7),rect(dogLane.x-.8,dogLane.near-.6,dogLane.x+.8,dogLane.far+.6)];
    zones.forEach((zone,i)=>{
      shape(zone,colors[i]+'26',true);
      segments([...zone,zone[0]],colors[i]);
    });
    state.cameras.forEach((c,i)=>segments([[c.x,c.y,c.z],c.aim],colors[i]+'88'));
  }
  const entities=state.game.players.map(([x,z],i)=>({p:[x,0,z],type:'player',i}));
  entities.push({p:state.game.ball,type:'ball'});
  state.cameras.forEach((c,i)=>{if(i!==index)entities.push({p:[c.x,0,c.z],type:'rig',i,c})});
  function disc(x,y,r,color){
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  }
  entities.map(e=>({...e,screen:project(e.p)})).filter(e=>e.screen).sort((a,b)=>b.screen[2]-a.screen[2]).forEach(e=>{
    const [x,y,z]=e.screen, k=focal/z;
    if(e.type==='ball'){disc(x,y,k*.13,'#ff781f');return}
    const [px,,pz]=e.p;
    const head=project([px,e.type==='player'?1.72:e.c.y,pz]);
    if(!head)return;
    const [hx,hy]=head;
    if(e.type==='player'){
      ctx.lineWidth=k*.11;segments([[px-.18,0,pz],[px,.74,pz],[px+.18,0,pz]],'#242d40');
      ctx.lineWidth=k*.47;segments([[px,.76,pz],[px,1.48,pz]],e.i<5?'#1680f7':'#de3f5b');
      disc(hx,hy,k*.14,'#f0ba91');
    }else{
      const c=colors[e.i];ctx.lineWidth=k*.08;
      if(e.i===2)segments([[px,0,pz],[px,e.c.y,pz]],c);
      else {
        ctx.fillStyle=c;ctx.fillRect(x-k*.45,hy+k*.16,k*.9,k*.29);
        for(const a of [-.32,.32]) {
          if(e.i===0)disc(x+k*a,y-k*.15,k*.15,'#06121e');
          else segments([[px+a,.65,pz],[px+a,.25,pz+.22],[px+a,0,pz]],c);
        }
      }
      ctx.fillStyle='#071324';ctx.fillRect(hx-k*.21,hy-k*.14,k*.42,k*.28);
      ctx.fillStyle=c;ctx.font='bold '+Math.max(8,w/65)+'px system-ui';ctx.fillText('CAM 0'+(e.i+1),hx+5,hy-6);
    }
  });
  if(camera){
    ctx.strokeStyle=camera.blocked?'#ff7985':'#7fffd5';
    ctx.lineWidth=1;ctx.strokeRect(w*.44,h*.4,w*.12,h*.2);
    if(camera.blocked){ctx.fillStyle='#0d1523bb';ctx.fillRect(w*.35,h*.23,w*.3,h*.65)}
  }
}
const previews=names.map((name,i)=>{
  const button=document.createElement('button');
  button.innerHTML='<canvas width="320" height="180"></canvas><span>0'+(i+1)+' · '+name+'</span>';
  button.onclick=()=>{selected=i;render()};
  $('feeds').append(button);return button;
});
phases.forEach((name,i)=>{
  const b=document.createElement('button');b.textContent=clock(i*600)+' '+name;
  b.onclick=()=>seek(i*600);$('events').append(b);
});
const metrics=entries=>entries.map(([name,value])=>'<div class="metric"><span>'+name+'</span><strong>'+value+'</strong></div>').join('');
function render(){
  const state=stateAt(frame), c=state.cameras[selected], cfg=state.config;
  $('orbitTools').hidden=programView;
  $('scene').classList.toggle('orbit',!programView);
  $('score').textContent='蓝队 '+state.game.scores[0]+'  :  '+state.game.scores[1]+' 红队';
  $('clock').textContent=clock(frame)+' / 02:00';$('seek').value=frame;
  $('play').textContent=playing?'暂停':'播放';
  $('wide').classList.toggle('on',!programView);$('program').classList.toggle('on',programView);
  $('viewTitle').textContent=programView?'导播输出 · '+(names[state.active]??'无信号'):'球馆总览 · '+phases[Math.min(5,Math.floor(frame/600))];
  draw($('scene'),state,programView?(state.active<0?-2:state.active):-1);
  previews.forEach((b,i)=>{
    b.classList.toggle('on',selected===i);draw(b.firstElementChild,state,i);
    b.lastElementChild.textContent='0'+(i+1)+' · '+names[i]+(state.active===i?' / 在播':'');
  });
  const status=c.offline?'离线':c.blocked?'遮挡':selected<2&&cfg.stop?'底盘急停':c.quality<cfg.threshold?'跟踪丢失':'跟踪中';
  $('telemetry').innerHTML=metrics([['设备',names[selected]],['职责',roles[selected]],['状态',status],
    ['坐标 X / Z',c.x.toFixed(1)+' / '+c.z.toFixed(1)+' m'],['移动速度',c.velocity.toFixed(2)+' m/s'],...(selected===1?[['底线外行程',(dogLane.far-dogLane.near).toFixed(1)+' m']]:[]),
    ['模拟置信度',Math.round(c.quality*100)+'%'],['导播机位',names[state.active]??'无合格信号']]);
  for(const key of Object.keys(cfg)) {
    if(typeof cfg[key]==='boolean')$(key).checked=cfg[key];else $(key).value=cfg[key];
  }
  $('speedVal').value=cfg.limit+' m/s';$('thresholdVal').value=Math.round(cfg.threshold*100)+'%';
  const logs=[];
  for(let i=frame;i>=0&&logs.length<8;i--){
    const s=history[i];
    if(edits.some(e=>e.frame===i))logs.push(clock(i)+' · 应用干预');
    if(s.cut===i)logs.push(clock(i)+' · '+(names[s.active]??'无合格信号'));
  }
  $('log').innerHTML=logs.map(x=>'<li>'+x+'</li>').join('');
}
function seek(to){frame=to;carry=0;render()}
$('seek').oninput=e=>seek(Number(e.target.value));
$('reset').onclick=()=>{playing=false;seek(0)};
$('play').onclick=()=>{if(!playing&&frame===END)seek(0);playing=!playing;render()};
$('wide').onclick=()=>{programView=false;render()};
$('program').onclick=()=>{programView=true;render()};
$('edit').onchange=e=>$('controls').disabled=!e.target.checked;
for(const key of Object.keys(defaults)){
  $(key).oninput=e=>{
    const config={...stateAt(frame).config,[key]:typeof defaults[key]==='boolean'?e.target.checked:Number(e.target.value)};
    edits=edits.filter(event=>event.frame<frame);edits.push({frame,config});
    history.length=frame;render();
  };
}
const scene=$('scene');
function redrawOverview(){if(!programView)draw(scene,stateAt(frame),-1)}
function orbit(yaw,pitch){
  overview.yaw+=yaw;
  overview.pitch=clamp(overview.pitch+pitch,.12,1.55);
  redrawOverview();
}
function zoom(factor){
  overview.distance=clamp(overview.distance*factor,22,85);
  redrawOverview();
}
let drag=null;
scene.addEventListener('pointerdown',e=>{
  if(programView||drag||e.button!==0)return;
  drag={id:e.pointerId,x:e.clientX,y:e.clientY};
  scene.setPointerCapture(e.pointerId);
  scene.classList.add('dragging');
});
scene.addEventListener('pointermove',e=>{
  if(programView||drag?.id!==e.pointerId)return;
  orbit((drag.x-e.clientX)*.007,(e.clientY-drag.y)*.007);
  drag.x=e.clientX;drag.y=e.clientY;
});
scene.addEventListener('lostpointercapture',()=>{
  drag=null;scene.classList.remove('dragging');
});
scene.addEventListener('wheel',e=>{
  if(programView)return;
  e.preventDefault();
  zoom(e.deltaY>0?1.09:e.deltaY<0?1/1.09:1);
},{passive:false});
scene.addEventListener('keydown',e=>{
  if(programView)return;
  switch(e.key){
    case 'ArrowLeft':orbit(-.12,0);break;
    case 'ArrowRight':orbit(.12,0);break;
    case 'ArrowUp':orbit(0,.1);break;
    case 'ArrowDown':orbit(0,-.1);break;
    case '+':case '=':zoom(.9);break;
    case '-':zoom(1.1);break;
    default:return;
  }
  e.preventDefault();
});
$('topView').onclick=()=>{
  Object.assign(overview,{yaw:0,pitch:1.55,distance:51});
  redrawOverview();
};
$('resetView').onclick=()=>{Object.assign(overview,overviewDefault);redrawOverview()};
let last=performance.now();
function tick(now){
  const dt=Math.min((now-last)/1000,.25);last=now;
  if(playing){
    carry+=dt*FPS*Number($('speed').value);
    const advance=Math.floor(carry);
    if(advance){
      carry-=advance;frame=Math.min(END,frame+advance);
      if(frame===END)playing=false;
      render();
    }
  }
  requestAnimationFrame(tick);
}
render();requestAnimationFrame(tick);
