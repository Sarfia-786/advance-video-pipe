export async function request(path, init) {
  const response = await fetch(path,{...init,cache:'no-store',credentials:'same-origin'});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.code || 'network');
  return body;
}
export function jsonForm(method,payload) {
  return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)};
}
export function folderOptions(folders) {
  const byId = new Map(folders.map(f => [f.id,f]));
  return folders.map(folder => {
    const names = [folder.name];
    for (let id=folder.parentId; byId.has(id); id=byId.get(id).parentId) names.push(byId.get(id).name);
    return {id:folder.id,path:names.reverse().join(' / ')};
  }).sort((a,b)=>a.path.localeCompare(b.path));
}
