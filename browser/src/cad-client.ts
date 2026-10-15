import type {CadDocument,BuildResult,CadProgress,CadRequest,CadResponse,ExportResult} from './types';
export class CadClient {
  private worker: Worker;
  private nextId=0;
  private pending=new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void;progress?:(p:CadProgress)=>void}>();
  constructor(){
    const url=URL.createObjectURL(new Blob([window.__EDU3D_WORKER_SOURCE__],{type:'text/javascript'}));
    this.worker=new Worker(url); URL.revokeObjectURL(url);
    this.worker.onmessage=(event:MessageEvent<CadResponse>)=>{const r=event.data,p=this.pending.get(r.id);if(!p)return;if(r.type==='progress'){p.progress?.(r.progress);return;}this.pending.delete(r.id);if(r.type==='error')p.reject(new Error(r.message));else p.resolve('result'in r?r.result:undefined);};
    this.worker.onerror=(e)=>{this.pending.forEach(p=>p.reject(new Error(e.message||'No se pudo iniciar el motor CAD.')));this.pending.clear();};
  }
  private request(message:Omit<CadRequest,'id'>|any,progress?:(p:CadProgress)=>void):Promise<any>{const id=++this.nextId;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,progress});this.worker.postMessage({...message,id});});}
  init():Promise<void>{return this.request({type:'init'});}
  build(document:CadDocument,onProgress?:(p:CadProgress)=>void):Promise<BuildResult>{return this.request({type:'build',document},onProgress);}
  export(format:'step'|'stl',bodyIds?:string[]):Promise<ExportResult>{return this.request({type:'export',format,bodyIds});}
  dispose(){this.worker.terminate();this.pending.forEach(p=>p.reject(new Error('Editor cerrado')));this.pending.clear();}
}
