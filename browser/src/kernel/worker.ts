import opencascade from 'replicad-opencascadejs';
import {setOC} from 'replicad';
import {CadEngine} from './engine';
import type {CadRequest,CadResponse} from '../types';
let engine:CadEngine;
let initializing:Promise<void>|undefined;
function send(message:CadResponse,transfer:Transferable[]=[]){postMessage(message,transfer);}
async function init(){if(!initializing)initializing=(async()=>{
  const binary=atob(__EDU3D_WASM_BASE64__);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  const wasm=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const oc=await opencascade({wasmBinary:new Uint8Array(wasm),locateFile:()=>'',print:()=>{},printErr:()=>{}});setOC(oc);engine=new CadEngine();
})();return initializing;}
let queue=Promise.resolve();
onmessage=(event:MessageEvent<CadRequest>)=>{const r=event.data;queue=queue.then(async()=>{try{await init();if(r.type==='init'){send({id:r.id,type:'ready'});return;}if(r.type==='build'){const result=await engine.build(r.document,p=>send({id:r.id,type:'progress',progress:p}));const transfer:Transferable[]=[];for(const b of result.bodies)transfer.push(b.mesh.vertices.buffer,b.mesh.normals.buffer,b.mesh.triangles.buffer,b.edgePositions.buffer);send({id:r.id,type:'result',result},transfer);return;}const result=await engine.export(r.format,r.bodyIds);send({id:r.id,type:'export',result},[result.data]);}catch(e){send({id:r.id,type:'error',message:e instanceof Error?e.message:String(e)});}});};
