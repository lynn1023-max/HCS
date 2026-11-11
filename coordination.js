(() => {
  const get = id => document.getElementById(id);
  const duration = 24;
  const lastFrame = duration * FPS - 1;
  const eventStarts = [0, 3, 9, 12, 14.5, 18];
  const events = [
    ['half_court','半场阵地','保留攻防布局，同时跟踪持球人。'],
    ['fast_break','快速反击','并行跟拍持球人和预置篮下机位，备用机位持续观察。'],
    ['paint_attack','篮下进攻','保留全景和篮下预置，跟拍失效时由备用机位接替。'],
    ['shot','投篮','沿用篮下预置，触发篮下特写。'],
    ['rebound','篮板争抢','以区域观察保留篮筐和争抢球员。'],
    ['dead_ball','死球','释放局部跟拍任务，保留全景。']
  ];
  const device = [
    {name:'轮式边线机位', code:'cam_02', tags:['tracking'],  pose:[-8,1.6,11], quality:.94},
    {name:'四足底线机位', code:'cam_04', tags:['tracking','backup','region'], pose:[17.5,1.2,3], quality:.78},
    {name:'固定全景机位', code:'cam_01', tags:['wide'], pose:[0,12,-21], quality:.98},
    {name:'篮下 PTZ', code:'cam_03', tags:['preset','close_up','region'], pose:[16,4,-10], quality:.91}
  ];
  const faultIds = ['wheelLost','ptzDown','dogDown','wideDown'];
  const catalog = {
    wide: ['WIDE_COVERAGE','全景保持','court','wide','immediate',[]],
    track: ['TARGET_TRACKING','持球人跟拍','player_07','tracking','immediate',[]],
    preset: ['PRE_POSITION','篮下预置','right_basket','preset','prepare_now',[]],
    close: ['CLOSE_UP','篮下特写','right_basket','close_up','shot',['preset']],
    backup: ['BACKUP_TRACKING','备用接替','player_07','backup','target_lost',[]],
    region: ['REGION_OBSERVATION','篮下区域观察','right_basket','region','immediate',[]]
  };
  const taskIdsByEvent = [
    ['wide','track'], ['wide','track','preset','close','backup'],
    ['wide','track','preset','close','backup'], ['wide','preset','close','track','backup'],
    ['wide','region'], ['wide']
  ];
  const edits = [];
  let frames = [], frame = 0, running = false, selected = -1, carry = 0;

  function sceneAt(t) {
    const attack = clamp((t-3)/9,0,1);
    const advance = lerp(-6.05,11.1,attack);
    const x = t < 3 ? -8 + t*.65 : advance;
    const z = t < 12 ? 1.5*Math.sin(t*.8) : 1.5*Math.sin(9.6);
    const scramble = t >= 14.5 && t < 18;
    const players = Array.from({length:10}, (_,i) => {
      const lane=i%5, team=i>=5;
      const gap=scramble?0.7:1.5;
      return [clamp(x-lane*gap+(team?1.4:0)+.6*Math.sin(t*1.5+i),-12.6,13),
        clamp(z+(lane-2)*(scramble?1.3:2.1)+(team?.65:0)+.45*Math.cos(t+i),-6.7,6.7)];
    });
    players[0]=[x,z];
    let ball=[x,.55+.6*Math.abs(Math.sin(t*8)),z];
    if(t>=12&&t<14.5) {
      const u=clamp((t-12)/1.45,0,1);
      const bounce=clamp((t-13.45)/1.05,0,1);
      ball=[lerp(x,12.6,u)-1.35*bounce,lerp(.95,3.1,u)+2*Math.sin(Math.PI*u)-1.6*bounce,lerp(z,0,u)+.9*bounce];
    } else if(scramble) ball=[11.25-.36*(t-14.5),1.5+.38*Math.abs(Math.sin((t-14.5)*5)),.9];
    else if(t>=18) ball=[11,1,.9];
    return {players,ball};
  }

  function planFor(phase){
    const tasks=taskIdsByEvent[phase].map(id=>{
      const [type,label,target,requires,timing,depends_on]=catalog[id];
      return {task_id:id,type,label,target,requires:[requires],timing,depends_on,
        priority:['wide','track'].includes(id)?'high':'medium',
        duration:id==='preset'?'until_ready':'until_event_end'};
    });
    const seen=new Set();
    for(const task of tasks){
      if(seen.has(task.task_id)||!task.depends_on.every(id=>seen.has(id))||
         !device.some(d=>task.requires.every(cap=>d.tags.includes(cap)))){
        throw new Error('Invalid task graph: '+task.task_id);
      }
      seen.add(task.task_id);
    }
    return {plan_id:'plan_'+String(phase+1).padStart(2,'0'),sport:'basketball',event:events[phase][0],source:'template_simulation',tasks};
  }
  const plans=events.map((_,i)=>planFor(i));

  function simulate(index,previous){
    const t=index/FPS, game=sceneAt(t);
    const phase=eventStarts.findLastIndex(start=>t>=start);
    const plan=plans[phase];
    const fault=edits.findLast(entry=>entry.frame<=index)?.values??{};
    const lost=fault.wheelLost??(t>=8.5&&t<11.5);
    const offline=[false,Boolean(fault.dogDown),Boolean(fault.wideDown),Boolean(fault.ptzDown)];
    const available=(i,task)=>!offline[i]&&!(i===0&&lost)&&
      task.requires.every(cap=>device[i].tags.includes(cap));
    const states={}, used=new Set(), byCamera=[];
    function assign(task, status, filter=()=>true) {
      const id=task.task_id, old=previous?.states[id];
      const candidates=device.map((d,i)=>({i,score:d.quality+(old?.camera===i ? .12 : 0)}))
        .filter(({i})=>!used.has(i)&&available(i,task)&&filter(i)).sort((a,b)=>b.score-a.score);
      const camera=candidates[0]?.i;
      if(camera===undefined) return states[id]={status:'BLOCKED'};
      used.add(camera);
      const since=old?.camera===camera&&old?.status!=='BLOCKED'?old.since:index;
      byCamera[camera]=id;
      return states[id]={camera,status:typeof status==='function'?status(index-since):status,since};
    }
    const lookup=id=>plan.tasks.find(task=>task.task_id===id);
    assign(lookup('wide'),'EXECUTING');
    if(lookup('track')) assign(lookup('track'),'EXECUTING',i=>i===0);
    if(lookup('preset')){
      const old=previous?.states.preset;
      const presetReady=old?.status==='READY'&&!offline[old.camera];
      if(phase===3&&presetReady){
        states.preset=old;
        assign(lookup('close'),'EXECUTING',i=>i===old.camera);
      }else{
        assign(lookup('preset'),elapsed=>elapsed>=FPS?'READY':'PREPARING');
        states.close={status:phase===3&&states.preset.status==='BLOCKED'?'BLOCKED':'WAITING'};
      }
    }
    if(lookup('backup')) assign(lookup('backup'),states.track.status==='EXECUTING'?'READY':'EXECUTING');
    if(lookup('region')) assign(lookup('region'),'EXECUTING');
    const cameras=device.map((d,i)=>{
      const id=byCamera[i], old=previous?.cameras[i], [homeX,y,z]=d.pose;
      const subject=[game.players[0][0],1.25,game.players[0][1]];
      const targetX=i===0&&id==='track'?clamp(subject[0],-12,12):homeX;
      const x=old?old.x+clamp(targetX-old.x,-3/FPS,3/FPS):homeX;
      const target=i===2?[0,0,0]:['preset','close','region'].includes(id)?[12.2,2.25,0]:subject;
      const aim=old?old.aim.map((v,j)=>v+clamp(target[j]-v,-.62,.62)):target;
      const targetFocal=[1.0,.94,.66,id==='close'?1.34:.88][i];
      const focal=old?old.focal+clamp(targetFocal-old.focal,-.05,.05):targetFocal;
      return {x,y,z,aim,focal,label:d.code.toUpperCase(),offline:offline[i],blocked:i===0&&lost,
        velocity:old?Math.abs(x-old.x)*FPS:0};
    });
    const event={sport:'basketball',timestamp_ms:Math.round(t*1000),
      event:{type:events[phase][0],phase:'ongoing',confidence:null,source:'simulation_truth'},
      key_targets:phase===5?[]:[{track_id:'player_07',role:'attacking_player',position_m:game.players[0].map(v=>Number(v.toFixed(2)))}],
      game_context:{attack_side:'right',ball_region:game.ball[0]<0?'left_half':game.ball[0]<8?'right_frontcourt':'right_paint'},
      camera_observations:Object.fromEntries(device.map((d,i)=>[d.code,offline[i]?'offline':i===0&&lost?'target_lost':'available']))};
    const changes=[];
    if(phase!==previous?.phase) changes.push(['感知',events[phase][1]],['规划',plan.plan_id+' · '+plan.tasks.length+' 项任务已校验']);
    for(const [i,c] of cameras.entries()){
      const prior=previous?.cameras[i];
      if(prior&&(c.offline!==prior.offline||c.blocked!==prior.blocked)){
        changes.push(['反馈',device[i].name+(c.offline?'断流':c.blocked?'目标丢失':'恢复可用')]);
      }
    }
    for(const [id,state] of Object.entries(states)){
      const old=previous?.states[id];
      if(state.status===old?.status&&state.camera===old?.camera) continue;
      const message=id==='backup'&&state.status==='EXECUTING'?'接替持球人跟拍':catalog[id][1]+' · '+state.status;
      changes.push(['调度',message+(state.camera===undefined?'':' · '+device[state.camera].name)]);
    }
    return {game,cameras,phase,plan,event,states,byCamera,changes,fault:{...fault,wheelLost:lost}};
  }

  function getFrame(index){
    for(let i=frames.length;i<=index;i++) frames.push(simulate(i,frames[i-1]));
    return frames[index];
  }
  const timeLabel = index => (index/FPS).toFixed(2).padStart(5,'0')+' s';
  const statusLabel = status => ({
    EXECUTING:'执行中',PREPARING:'调整中',READY:'已就绪',WAITING:'等待触发',BLOCKED:'无可用机位',
    IDLE:'待命',FAILED:'离线或遮挡'
  })[status];
  const stateBadge = status => '<span class="state" data-status="'+status+'">'+statusLabel(status)+'</span>';
  const tiles=device.map((d,i)=>{
    const b=document.createElement('button');
    b.className='agent';
    b.innerHTML='<canvas width="320" height="180" aria-hidden="true"></canvas><b></b><small></small><span class="state"></span>';
    b.children[1].textContent=d.code.toUpperCase()+' · '+d.name;
    b.onclick=()=>{selected=i;render()};
    get('agents').append(b);
    return b;
  });
  const markers=[...eventStarts.map((t,i)=>[t,events[i][1]]),[8.5,'机位接替']].sort((a,b)=>a[0]-b[0]);
  for(const [t,label] of markers){
    const b=document.createElement('button');
    b.textContent=t+' s '+label;
    b.onclick=()=>seek(Math.round(t*FPS));
    get('markers').append(b);
  }
  let lastInterface;
  function render(){
    const s=getFrame(frame);
    draw(get('arena'),s,selected);
    tiles.forEach((b,i)=>draw(b.firstElementChild,s,i));
    get('screenTitle').textContent=selected<0?'球馆总览':device[selected].name;
    get('time').value=timeLabel(frame)+' / 24 s';
    get('scrub').value=frame;
    get('run').textContent=running?'Ⅱ 暂停':'▶ 播放';
    const interfaceKey=[s.phase,selected,...faultIds.map(id=>Boolean(s.fault[id])),
      ...Object.values(s.states).map(task=>task.status+task.camera)].join('|');
    if(interfaceKey!==lastInterface){
      lastInterface=interfaceKey;
      get('eventSummary').innerHTML='<div class="event-name">'+events[s.phase][1]+'</div><div class="facts"><span>篮球</span><span>进攻方向 · 右侧</span><span>关键主体 · '+(s.phase===5?'—':'PLAYER 07')+'</span></div>';
      get('intent').textContent=events[s.phase][2];
      get('tasks').innerHTML=s.plan.tasks.map(task=>{
        const state=s.states[task.task_id];
        const assignee=state.camera===undefined?'待分配':device[state.camera].name;
        return '<div class="task"><strong>'+task.label+'</strong>'+stateBadge(state.status)+'<small>'+task.type+' · '+assignee+
          (task.depends_on.length?' · 依赖篮下预置':'')+'</small></div>';
      }).join('');
      tiles.forEach((b,i)=>{
        const camera=s.cameras[i], id=s.byCamera[i];
        const status=camera.offline||camera.blocked?'FAILED':s.states[id]?.status??'IDLE';
        b.setAttribute('aria-pressed',selected===i);
        b.children[2].textContent=camera.offline?'信号中断':camera.blocked?'目标丢失':catalog[id]?.[1]??'可用';
        b.children[3].textContent=statusLabel(status);
        b.children[3].dataset.status=status;
      });
      faultIds.forEach(id=>get(id).checked=Boolean(s.fault[id]));
      get('planJson').textContent=JSON.stringify(s.plan,null,2);
    }
    if(get('eventJson').parentElement.open||!get('eventJson').textContent){
      get('eventJson').textContent=JSON.stringify(s.event,null,2);
    }
    const logs=[];
    for(let i=frame;i>=0&&logs.length<10;i--){
      for(const [layer,message] of frames[i].changes.slice().reverse()){
        if(logs.length===10) break;
        logs.push('<li><time>'+timeLabel(i)+'</time>'+layer+' · '+message+'</li>');
      }
    }
    get('records').innerHTML=logs.join('');
  }
  get('eventJson').parentElement.addEventListener('toggle',()=>{if(get('eventJson').parentElement.open)render()});
  function seek(index){frame=index;carry=0;render()}
  get('scrub').oninput=e=>seek(Number(e.target.value));
  get('restart').onclick=()=>{running=false;seek(0)};
  get('handoff').onclick=()=>{running=false;seek(Math.round(8.5*FPS))};
  get('overviewButton').onclick=()=>{selected=-1;render()};
  get('run').onclick=()=>{
    if(!running&&frame===lastFrame)seek(0);
    running=!running;render();
  };
  for(const id of faultIds){
    get(id).onchange=e=>{
      const values={...edits.findLast(entry=>entry.frame<=frame)?.values,[id]:e.target.checked};
      while(edits.at(-1)?.frame>=frame)edits.pop();
      edits.push({frame,values});frames.length=frame;render();
    };
  }
  get('export').onclick=()=>{
    const records=frames.slice(0,frame+1).flatMap((s,i)=>s.changes.map(([stage,message])=>({
      timestamp_ms:Math.round(i/FPS*1000),stage,message
    })));
    const payload={source:'simulation',current_event:getFrame(frame).event,task_graph:getFrame(frame).plan,
      intervention_history:edits.filter(entry=>entry.frame<=frame),records};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='courtside-execution.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  let previousTick=performance.now();
  function tick(now){
    const elapsed=Math.min(.2,(now-previousTick)/1000);previousTick=now;
    if(running){
      carry+=elapsed*FPS*Number(get('rate').value);
      const advance=Math.floor(carry);
      if(advance){
        carry-=advance;frame=Math.min(lastFrame,frame+advance);
        if(frame===lastFrame)running=false;
        render();
      }
    }
    requestAnimationFrame(tick);
  }
  render();
  requestAnimationFrame(tick);
})();
