// 仅供 ui-harness 的内存 SDK 使用，不访问真实宿主或网络。
export function attachStreamHarness(ai, controls) {
  const deltas=new Set(), dones=new Set();
  controls.streams=[];
  controls.listenerCounts=()=>({delta:deltas.size,done:dones.size});
  ai.onStreamDelta=fn=>{deltas.add(fn);return()=>deltas.delete(fn);};
  ai.onStreamDone=fn=>{dones.add(fn);return()=>dones.delete(fn);};
  controls.emit=(text,index=controls.streams.length-1)=>{
    const item=controls.streams[index];item.text+=text;
    deltas.forEach(fn=>fn({streamId:item.args.streamId,delta:text}));
  };
  controls.finish=(result={},index=controls.streams.length-1)=>{
    const item=controls.streams[index];const response={ok:true,termination:'stop',truncated:false,finishReason:'stop',text:item.text,providerId:'test-only',model:'no-billing-model',...result};
    dones.forEach(fn=>fn({...response,streamId:item.args.streamId}));item.resolve(response);
  };
  ai.stream=args=>new Promise((resolve,reject)=>{
    const item={args,text:'',resolve,reject};controls.streams.push(item);
    if(controls.manualStream){controls.calls.push(JSON.parse(JSON.stringify(args)));return;}
    const index=controls.streams.length-1;
    ai.chat(args).then(async result=>{
      const text=result.text||'';const middle=Math.ceil(text.length/2);
      controls.emit(text.slice(0,middle),index);
      await new Promise(r=>setTimeout(r,120));
      controls.emit(text.slice(middle),index);controls.finish(result,index);
    },reject);
  });
}
