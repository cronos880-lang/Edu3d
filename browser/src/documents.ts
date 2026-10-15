import type {CadDocument} from './types';
export function createEmptyDocument():CadDocument{return {schema:'edu3d-cad',version:2,name:'Mi pieza',units:'mm',assets:{},features:[]};}
export function createDemoDocument():CadDocument{return {...createEmptyDocument(),name:'Soporte paramétrico',features:[
  {id:'base-sketch',name:'Boceto base',type:'sketch',plane:'XY',offset:0,entities:[{id:'outline',type:'rectangle',x:0,y:0,width:60,height:36},{id:'hole1',type:'circle',x:-20,y:0,radius:3,cut:true},{id:'hole2',type:'circle',x:20,y:0,radius:3,cut:true}]},
  {id:'base',name:'Extrusión base',type:'extrude',sketchId:'base-sketch',distance:6,mode:'new'},
  {id:'wall',name:'Soporte vertical',type:'primitive',kind:'box',mode:'add',target:'base',width:60,depth:6,height:28,radius:5,center:[0,15,20]},
]};}
export function parseDocument(text:string):CadDocument{const d=JSON.parse(text);if(d.schema!=='edu3d-cad'||d.version!==2||!Array.isArray(d.features)||d.features.length>200||!d.assets)throw new Error('Archivo de proyecto Edu3d v2 no válido.');return d;}
export function uid(){return crypto.randomUUID?.()||'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);}
