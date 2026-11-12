import {ADMIN_BROWSER_COPY} from './i18n/zh-CN.ts';
export const ADMIN_CSS=`.brand{display:flex;gap:.9rem;align-items:center}.brand-icon{width:44px;height:44px;flex:none}.brand-icon svg{display:block;width:44px;height:44px}.brand-subtitle .version{margin-left:.5rem;color:#286F78;font-size:.75rem}.brand h1{font-size:1.4rem;margin:0}.brand-subtitle{font-size:.8rem;margin:.25rem 0 0;color:GrayText;line-height:1.4}a{color:#286F78}:root{color-scheme:light dark;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}body{margin:0;background:Canvas;color:CanvasText}main{width:min(940px,92vw);margin:5vh auto}h1{font-size:1.8rem}h2{margin-top:2rem}p{line-height:1.6;color:GrayText}header{display:flex;align-items:center;justify-content:space-between}form#add{display:grid;gap:1rem;max-width:580px}label{display:grid;gap:.4rem;margin:.7rem 0}input,select{padding:.7rem;border:1px solid GrayText;border-radius:.4rem;background:Field;color:FieldText;font:inherit}input[type=checkbox]{width:auto}button{cursor:pointer;border:1px solid #286F78;background:#286F78;color:white;border-radius:.4rem;padding:.55rem 1rem;font:inherit}.secondary{background:transparent;color:CanvasText}.danger{background:transparent;border-color:#b3261e;color:#b3261e}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid GrayText;padding:.65rem;text-align:left;word-break:break-word}.muted{font-size:.9rem}#result{white-space:pre-wrap}code{word-break:break-all}details{min-width:220px}summary{cursor:pointer;color:#286F78}form.client-policy{min-width:min(560px,80vw);max-height:65vh;overflow:auto;padding:.6rem}fieldset{margin:.8rem 0;padding:.7rem;border:1px solid GrayText;border-radius:.4rem}.policy-label{margin-top:.7rem;font-weight:600}.policy-option{display:flex;align-items:flex-start;gap:.55rem;margin:.45rem 0}.policy-option input{margin-top:.25rem}.policy-option span{display:grid;gap:.2rem}
.admin-shell{width:min(1100px,calc(100% - 36px));margin:32px auto 72px}
.admin-shell header{padding:6px 0 22px;border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);gap:1.5rem}
.section-heading{margin:30px 0 22px}
.section-heading h2{font-size:1.65rem;margin:0 0 6px}
.section-heading p{margin:0;max-width:820px}
.panel{background:Canvas;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px;padding:22px 24px;margin:18px 0;box-shadow:0 2px 12px color-mix(in srgb,CanvasText 4%,transparent)}
.panel h2{font-size:1.15rem;margin:0 0 12px}
.panel h2+p{margin:6px 0 16px}
.panel table{font-size:.9rem}
.table-wrap{overflow-x:auto}
.service-directory{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:16px}
.service-card{border:1px solid color-mix(in srgb,#286F78 24%,transparent);border-radius:10px;padding:18px;background:color-mix(in srgb,Canvas 93%,#286F78 7%)}
.service-card h3{margin:0 0 8px;font-size:1.06rem}
.service-card p{margin:8px 0 12px;font-size:.88rem}
.service-card a{display:inline-block;margin-top:8px;font-weight:650;text-decoration:none}
.breadcrumbs{margin:24px 0 8px;font-size:.87rem;color:GrayText}
.breadcrumbs a{text-decoration:none}
.admin-shell form#add{max-width:540px}
.admin-shell button:disabled{opacity:.5;cursor:wait}
@media(max-width:680px){.admin-shell{width:calc(100% - 22px);margin:16px auto}.panel{padding:14px}.admin-shell header{align-items:flex-start}.brand-subtitle{max-width:210px}.service-directory{grid-template-columns:1fr}}
`;
export const ADMIN_SCRIPT=`'use strict';
const COPY=${JSON.stringify(ADMIN_BROWSER_COPY)};
(async()=>{
  const meta=document.querySelector('meta[name="csrf-token"]');if(!meta)return;
  const csrf=meta.content;const result=document.getElementById('result');
  const metrics=document.getElementById('dispatch-metrics');
  if(metrics){try{const r=await fetch('/admin/api/dispatch-metrics',{credentials:'same-origin'});if(!r.ok)throw new Error('Dispatch metrics temporarily unavailable');
    const m=await r.json();const counts=Object.entries(m.counts||{}).map(([state,count])=>state+': '+count).join('，')||'暂无派发记录';
    metrics.textContent=counts+'；排队 '+m.queuedCount+'，最久等待 '+m.oldestQueuedAgeSeconds+' 秒，活动租约 '+m.activeLeases+'，过期额度报告 '+m.staleQuotaReports;
  }catch{metrics.textContent='派发指标暂不可用'}}
  const enc=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
  async function encryptToken(token){
    let response;
    try{
      response=await fetch('/admin/api/public-key',{
        credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}
      });
    }catch{throw new Error(COPY.publicKeyNetworkError)}
    if(response.status===401)throw new Error(COPY.publicKeySessionExpired);
    if(response.status===403)throw new Error(COPY.publicKeyAccessDenied);
    if(response.status===503||response.status===500)throw new Error(COPY.publicKeyServerUnavailable);
    if(!response.ok)throw new Error(COPY.publicKeyRequestFailed+' (HTTP '+response.status+')');
    let pub;
    try{pub=await response.json()}catch{throw new Error(COPY.publicKeyInvalidResponse)}
    if(!pub||pub.kty!=='RSA'||typeof pub.n!=='string'||!pub.n||
      typeof pub.e!=='string'||!pub.e||pub.d)throw new Error(COPY.missingPublicKey);
    const rsa=await crypto.subtle.importKey('jwk',pub,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
    const raw=await crypto.subtle.exportKey('raw',aes);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(token));
    const wrappedKey=await crypto.subtle.encrypt({name:'RSA-OAEP'},rsa,raw);
    return {wrappedKey:enc(wrappedKey),iv:enc(iv),ciphertext:enc(ciphertext)};
  }
  async function api(path,body){
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},credentials:'same-origin',body:JSON.stringify(body)});
    const out=await r.json();if(!r.ok)throw new Error(out.error||COPY.requestFailed);return out;
  }
  document.getElementById('add')?.addEventListener('submit',async ev=>{
    ev.preventDefault();const f=ev.currentTarget;const btn=f.querySelector('button');btn.disabled=true;
    try{const token=f.elements.token.value;const encrypted=await encryptToken(token);
      const out=await api('/admin/api/connections',{owner:f.elements.owner.value.trim(),kind:f.elements.kind.value,encrypted});
      f.elements.token.value='';result.textContent=COPY.saved+out.owner;location.reload();
    }catch(e){f.elements.token.value='';result.textContent=e.message}finally{btn.disabled=false}
  });
  document.querySelectorAll('.toggle').forEach(b=>b.addEventListener('click',async()=>{
    try{await api('/admin/api/status',{owner:b.dataset.owner,enabled:b.dataset.enabled==='1'});location.reload()}
    catch(e){result.textContent=e.message}
  }));
  document.querySelectorAll('.delete').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm(COPY.deletePrefix+b.dataset.owner+COPY.deleteSuffix))return;
    try{await api('/admin/api/delete',{owner:b.dataset.owner});location.reload()}
    catch(e){result.textContent=e.message}
  }));
  document.querySelectorAll('.client-policy').forEach(form=>form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const allowedResources=[...form.querySelectorAll('.resource-grant:checked')].map(x=>x.value);
    const allowedTools=[...form.querySelectorAll('.tool-grant:checked')].map(x=>x.value);
    const allowedOwners=form.querySelector('.client-owners').value.split(',').map(x=>x.trim()).filter(Boolean);
    const allowWrite=form.querySelector('.client-write').checked;
    if(!allowedResources.length||!allowedTools.length){result.textContent=COPY.permissionsRequired;return}
    if(allowWrite&&!confirm(COPY.allowWriteConfirm))return;
    try{await api('/admin/api/client-approval',{clientId:form.dataset.client,approved:true,allowedOwners,allowedResources,allowedTools,allowWrite});location.reload()}
    catch(e){result.textContent=e.message}
  }));
  document.querySelectorAll('.revoke-client').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm(COPY.revokeClientConfirm))return;
    try{await api('/admin/api/client-approval',{clientId:b.dataset.client,approved:false});location.reload()}
    catch(e){result.textContent=e.message}
  }));
  document.querySelectorAll('.delete-client').forEach(b=>b.addEventListener('click',async()=>{
    const name=b.dataset.clientName||'';
    const clientId=b.dataset.client||'';
    if(!confirm(COPY.deleteClientPrefix+name+' ('+clientId+')'+COPY.deleteClientSuffix))return;
    b.disabled=true;
    try{await api('/admin/api/client-delete',{clientId,confirmClientId:clientId});location.reload()}
    catch(e){b.disabled=false;result.textContent=e.message}
  }));
  document.querySelectorAll('.approve-operation').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm(COPY.approveOperationConfirm))return;
    try{const response=await api('/admin/api/operation',{id:b.dataset.operation,action:'approve'});result.textContent=JSON.stringify(response);location.reload()}
    catch(e){result.textContent=e.message}
  }));
  document.querySelectorAll('.deny-operation').forEach(b=>b.addEventListener('click',async()=>{
    try{await api('/admin/api/operation',{id:b.dataset.operation,action:'deny'});location.reload()}
    catch(e){result.textContent=e.message}
  }));
  document.getElementById('rekey')?.addEventListener('click',async()=>{
    if(!confirm(COPY.rekeyConfirm))return;
    try{const out=await api('/admin/api/rekey',{});result.textContent=COPY.rekeyPrefix+out.processed+COPY.rekeyInfix+out.remaining+COPY.rekeySuffix}
    catch(e){result.textContent=e.message}
  });
  document.getElementById('runner-add')?.addEventListener('submit',async ev=>{
    ev.preventDefault();const f=ev.currentTarget;const btn=f.querySelector('button');btn.disabled=true;
    try{const out=await api('/admin/api/runners/provision',{displayName:f.elements.displayName.value.trim(),capabilities:f.elements.capabilities.value.split(',').map(x=>x.trim()).filter(Boolean),maxConcurrency:Number(f.elements.maxConcurrency.value)});
      result.textContent='Runner ID: '+out.runnerId+'\\n凭据（仅显示这一次，请安全保存）: '+out.token+'\\n保存后刷新页面查看 Runner 状态。';f.reset();
    }catch(e){result.textContent=e.message}finally{btn.disabled=false}
  });
  document.querySelectorAll('.revoke-runner').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('撤销 Runner '+b.dataset.runner+'？这会停用其凭据并释放 Hub 租约。'))return;
    try{await api('/admin/api/runners/revoke',{runnerId:b.dataset.runner});location.reload()}
    catch(e){result.textContent=e.message}
  }));
})();`;
