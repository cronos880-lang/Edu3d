import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';
createServer(async(req,res)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile('dist/index.html'));}catch{res.statusCode=503;res.end('Ejecuta npm run build primero');}}).listen(Number(process.env.PORT||8080),'0.0.0.0');
