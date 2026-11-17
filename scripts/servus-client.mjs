export function connection(env=process.env) {
  const url=new URL(env.SERVUS_URL||'http://127.0.0.1:4180');
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol))throw new Error('SERVUS_URL must be the panel origin without credentials or a path.');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Remote panels require HTTPS. Use an SSH tunnel for a local HTTP connection.');
  if(!/^srv_[a-f0-9]{64}$/.test(env.SERVUS_TOKEN||''))throw new Error('Set SERVUS_TOKEN to a project API token from Settings.');
  return {origin:url.origin,token:env.SERVUS_TOKEN};
}

export async function request(path,{method='GET',body,key}={},config=connection()) {
  if(!path.startsWith('/')||path.includes('..')||path.includes('?')||path.includes('#'))throw new Error('Invalid API path.');
  let response;
  try {response=await fetch(`${config.origin}/api/v1${path}`,{method,redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Accept:'application/json',Authorization:`Bearer ${config.token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch {throw new Error(`The panel could not be reached. Inspect action history before retrying a mutation.${key?` Reuse idempotency key ${key}.`:''}`);}
  let data;
  try {data=await response.json();}catch {throw new Error('The panel returned an unreadable response.');}
  if(!response.ok)throw new Error(`${response.status} ${data?.error?.code||'REQUEST_FAILED'}: ${data?.error?.message||'The request failed.'}`);
  return data;
}

export function resourceId(value) {
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||''))throw new Error('Expected a resource UUID.');
  return value;
}
