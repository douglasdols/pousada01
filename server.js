'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const publicDir=path.join(__dirname,'public'),port=Number(process.env.PORT||3000);
const base=(process.env.SUPABASE_URL||'').replace(/\/$/,''),key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'',pub=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'';
const configured=base.startsWith('https://')&&!!key&&!!pub;
const h={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const send=(res,status,data)=>{res.writeHead(status,h);res.end(JSON.stringify(data));};
const clean=x=>String(x??'').trim();
const dateValue=s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return false;const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const stay=(a,b)=>dateValue(a)&&dateValue(b)&&a>=today()&&((Date.parse(b)-Date.parse(a))/86400000)>=1&&((Date.parse(b)-Date.parse(a))/86400000)<=30;
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>12000)throw Object.assign(Error('Requisição muito grande'),{status:413});}try{return JSON.parse(raw||'{}');}catch{throw Object.assign(Error('JSON inválido'),{status:400});}}
async function sb(route,{method='GET',data,token=key,apiKey=key,extra={}}={}){
 const r=await fetch(base+route,{method,headers:{apikey:apiKey,Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(12000)});
 const txt=await r.text();let value;try{value=txt?JSON.parse(txt):null;}catch{value={message:txt};}
 if(!r.ok){const e=Error(value?.message||value?.error_description||value?.error||'Falha no banco de dados');e.status=r.status;e.code=value?.code;throw e;}return value;
}
async function admin(req){const auth=req.headers.authorization||'';if(!/^Bearer [A-Za-z0-9._~-]+$/.test(auth))throw Object.assign(Error('Faça login para continuar'),{status:401});const token=auth.slice(7);
 const user=await sb('/auth/v1/user',{token,apiKey:pub});if(!user?.id)throw Object.assign(Error('Sessão inválida'),{status:401});
 const roles=await sb('/rest/v1/pb_admins?select=user_id&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1');
 if(!roles.length)throw Object.assign(Error('Usuário sem permissão administrativa'),{status:403});return user;
}
const handler=async(req,res)=>{let url;try{url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  if(!configured)return send(res,503,{error:'Supabase não configurado. Consulte README.md e .env.example.'});
  if(req.method==='GET'&&url.pathname==='/api/rooms'){
   const a=url.searchParams.get('checkin'),b=url.searchParams.get('checkout'),g=Number(url.searchParams.get('guests')||2),valid=stay(a,b);
   const rooms=await sb('/rest/v1/pb_rooms?select=*&active=eq.true&order=price.desc');
   const bookings=valid?await sb('/rest/v1/pb_bookings?select=room_id,checkin,checkout,status&status=in.(pending,confirmed)&checkin=lt.'+encodeURIComponent(b)+'&checkout=gt.'+encodeURIComponent(a)):[];
   const nights=valid?(Date.parse(b)-Date.parse(a))/86400000:null;
   return send(res,200,{demo:true,rooms:rooms.map(r=>({id:r.id,name:r.name,type:r.type,description:r.description,capacity:r.capacity,units:r.units,price:Number(r.price),amenities:r.amenities,image:r.image,available:valid?(Number.isInteger(g)&&g>=1&&g<=r.capacity?Math.max(0,r.units-bookings.filter(x=>x.room_id===r.id).length):0):r.units,nights,total:nights===null?null:nights*Number(r.price)}))});
  }
  if(req.method==='POST'&&url.pathname==='/api/bookings'){
   const p=await body(req);if(!stay(p.checkin,p.checkout)||!p.acceptedTerms||!Number.isInteger(Number(p.guests))||clean(p.name).length<3||clean(p.name).length>200||clean(p.email).length>200||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(p.email))||clean(p.phone).replace(/\D/g,'').length<10||clean(p.phone).length>50||clean(p.notes).length>200)return send(res,400,{error:'Revise datas, contato e aceite das condições.'});
   const data=await sb('/rest/v1/rpc/pb_create_booking',{method:'POST',data:{p_room_id:clean(p.roomId),p_checkin:p.checkin,p_checkout:p.checkout,p_guests:Number(p.guests),p_name:clean(p.name),p_email:clean(p.email),p_phone:clean(p.phone),p_notes:clean(p.notes)}});return send(res,201,data);
  }
  if(req.method==='POST'&&url.pathname==='/api/admin/login'){
   const p=await body(req);if(!clean(p.email)||!p.password)return send(res,400,{error:'Informe e-mail e senha.'});
   const session=await sb('/auth/v1/token?grant_type=password',{method:'POST',data:{email:clean(p.email),password:p.password},token:pub,apiKey:pub});
   await admin({headers:{authorization:'Bearer '+session.access_token}});
   return send(res,200,{access_token:session.access_token,expires_in:session.expires_in});
  }
  if(url.pathname.startsWith('/api/admin/')){
   await admin(req);
   if(req.method==='GET'&&url.pathname==='/api/admin/bookings'){
    const data=await sb('/rest/v1/pb_bookings?select=*&order=created_at.desc&limit=500');
    return send(res,200,{bookings:data.map(b=>({id:b.id,roomId:b.room_id,roomName:b.room_name,checkin:b.checkin,checkout:b.checkout,nights:b.nights,guests:b.guests,name:b.name,email:b.email,phone:b.phone,notes:b.notes,total:Number(b.total),status:b.status,createdAt:b.created_at}))});
   }
   if(req.method==='PATCH'&&/^\/api\/admin\/bookings\/[^/]+$/.test(url.pathname)){
    const p=await body(req),id=decodeURIComponent(url.pathname.split('/').pop());
    const result=await sb('/rest/v1/rpc/pb_set_booking_status',{method:'POST',data:{p_id:id,p_status:p.status}});return send(res,200,result);
   }
   if(req.method==='GET'&&url.pathname==='/api/admin/rooms')return send(res,200,{rooms:await sb('/rest/v1/pb_rooms?select=*&order=price.desc')});
   if(req.method==='PATCH'&&/^\/api\/admin\/rooms\/[a-z0-9-]+$/.test(url.pathname)){
    const p=await body(req),id=url.pathname.split('/').pop(),data={};
    if(p.price!==undefined){if(!Number.isFinite(Number(p.price))||Number(p.price)<0||Number(p.price)>1000000)return send(res,400,{error:'Tarifa inválida'});data.price=Number(p.price);}
    if(p.units!==undefined){if(!Number.isInteger(Number(p.units))||Number(p.units)<0||Number(p.units)>100)return send(res,400,{error:'Unidades inválidas'});data.units=Number(p.units);}
    if(p.active!==undefined){if(typeof p.active!=='boolean')return send(res,400,{error:'Estado inválido'});data.active=p.active;}
    if(!Object.keys(data).length)return send(res,400,{error:'Nenhuma alteração'});
    const result=await sb('/rest/v1/pb_rooms?id=eq.'+encodeURIComponent(id),{method:'PATCH',data,extra:{Prefer:'return=representation'}});return send(res,200,{room:result[0]||null});
   }
  }
  return send(res,404,{error:'Rota não encontrada'});
 }
 if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'Método não permitido'});
 const requested=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);const target=path.resolve(publicDir,'.'+requested);
 if(!(target===publicDir||target.startsWith(publicDir+path.sep)))return send(res,403,{error:'Acesso negado'});
 let stat;try{stat=fs.statSync(target);}catch{return send(res,404,{error:'Página não encontrada'});}if(!stat.isFile())return send(res,404,{error:'Página não encontrada'});
 const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
 res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'public,max-age=300'});if(req.method==='HEAD')return res.end();fs.createReadStream(target).pipe(res);
 }catch(err){console.error('Request error',err.message);const status=err.code==='P0001'?409:err.code==='22023'?400:err.code==='P0002'?404:err.status===401?401:err.status===403?403:err.status===400?400:err.status===413?413:502;return send(res,status,{error:status===502?'Não foi possível consultar o serviço de reservas.':err.message});}};
if(require.main===module)http.createServer(handler).listen(port,'0.0.0.0',()=>console.log('Paraty Boutique v1.1.0 http://localhost:'+port));
module.exports={handler,stay};
