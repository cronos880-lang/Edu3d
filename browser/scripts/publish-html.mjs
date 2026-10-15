import {mkdir,copyFile,writeFile} from 'node:fs/promises';
await mkdir('../docs',{recursive:true});
await copyFile('dist/index.html','../docs/index.html');
await copyFile('dist/Edu3d-Editor.html','../docs/Edu3d-Editor.html');
await copyFile('THIRD_PARTY_NOTICES.txt','../docs/THIRD_PARTY_NOTICES.txt');
await writeFile('../docs/.nojekyll','');
console.log('HTML actualizado en docs/, listo para GitHub y GitHub Pages.');
