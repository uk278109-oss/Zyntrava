const Z={channel:'https://t.me/ZyntravaOfficial',support:'https://t.me/Zyntrava',uid:null,user:null,profile:null};
const countries={PK:{name:'Pakistan',currency:'PKR',symbol:'Rs',methods:['JazzCash','EasyPaisa','SadaPay','NayaPay','Bank Transfer']},US:{name:'United States',currency:'USD',symbol:'$',methods:['PayPal','Bank Transfer']},GB:{name:'United Kingdom',currency:'GBP',symbol:'£',methods:['PayPal','Bank Transfer']},IN:{name:'India',currency:'INR',symbol:'₹',methods:['UPI','Bank Transfer']},AE:{name:'United Arab Emirates',currency:'AED',symbol:'AED',methods:['Bank Transfer']},DEFAULT:{name:'Global',currency:'USD',symbol:'$',methods:['Bank Transfer']}};
function sound(n='click'){try{window.ZynSound?.play?.(n)}catch(e){}}
function toast(t,type=''){let e=document.querySelector('.toast');if(!e){e=document.createElement('div');e.className='toast';e.style.cssText='position:fixed;right:18px;top:18px;background:#10243b;border:1px solid rgba(79,209,255,.3);padding:13px 17px;border-radius:12px;z-index:999;color:white;max-width:340px;box-shadow:0 15px 40px rgba(0,0,0,.35)'}e.textContent=t;document.body.append(e);setTimeout(()=>e.remove(),3200)}
function fmt(n){return Number(n||0).toLocaleString()}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function countryCfg(){return countries[Z.profile?.countryCode||Z.profile?.country]||countries.DEFAULT}
async function api(action,body={}){if(!Z.user)throw new Error('Please sign in again.');const token=await Z.user.getIdToken();const r=await fetch('/api?action='+encodeURIComponent(action),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body)});const d=await r.json().catch(()=>({ok:false,error:'Invalid server response'}));if(!r.ok||d.ok===false)throw new Error(d.error||'Request failed');return d}
async function ensureProfile(u){
  try{
    Z.user=u;
    await api('bootstrap-user',{});
    const code=new URLSearchParams(location.search).get('ref');
    if(code){
      await api('register-referral',{code});
      try{
        const clean=new URL(location.href);
        clean.searchParams.delete('ref');
        history.replaceState({},'',clean.pathname+(clean.search||'')+(clean.hash||''));
      }catch(e){}
    }
  }catch(e){console.error('Profile bootstrap failed:',e)}
}
async function logout(){if(!confirm('Log out of your Zyntrava account?'))return;sound('click');try{await ZAUTH.signOut()}finally{location.replace('index.html')}}
function bindUser(){if(!ZAUTH)return;ZAUTH.onAuthStateChanged(u=>{const onIndex=location.pathname.endsWith('index.html')||location.pathname.endsWith('/');if(!u){if(!onIndex)location.replace('index.html');return}if(onIndex){location.replace('dashboard.html');return}Z.user=u;Z.uid=u.uid;const ref=ZDB.ref('users/'+u.uid);ref.on('value',s=>{Z.profile=s.val()||{};document.querySelectorAll('[data-user]').forEach(e=>e.textContent=Z.profile.displayName||Z.profile.name||u.displayName||u.email?.split('@')[0]||'Member');document.querySelectorAll('[data-points]').forEach(e=>e.textContent=fmt(Z.profile.points));document.querySelectorAll('[data-earned]').forEach(e=>e.textContent=fmt(Z.profile.earnedPoints));document.querySelectorAll('[data-country]').forEach(e=>e.textContent=countryCfg().name);document.querySelectorAll('[data-member]').forEach(e=>e.textContent=Z.profile.memberId||'—');renderPage()});ensureProfile(u).catch(e=>console.error('Profile bootstrap failed:',e))})}
function renderPage(){const p=document.body.dataset.page;if(p==='withdraw'){const c=countryCfg(),sel=document.querySelector('#method');if(sel)sel.innerHTML=c.methods.map(x=>`<option>${esc(x)}</option>`).join('');const info=document.querySelector('#currencyInfo');if(info)info.textContent=`${c.name} • ${c.currency} payout options • rate configured by platform`}
if(p==='profile'){const email=document.querySelector('#email'),country=document.querySelector('#country'),name=document.querySelector('#displayName');if(email)email.textContent=Z.user?.email||'';if(country)country.value=Z.profile?.countryCode||'PK';if(name)name.value=Z.profile?.displayName||''}
if(p==='dashboard')loadDashboard();if(p==='wallet')loadWallet();if(p==='withdraw')loadWithdrawalHistory();if(p==='tasks')loadTasks();if(p==='transactions')loadTransactions();if(p==='watch')loadRewardedCampaigns();if(p==='leaderboard')loadLeaderboard();if(p==='daily')loadDaily();}
async function saveProfile(){const n=document.querySelector('#displayName').value.trim(),c=document.querySelector('#country').value;try{await api('profile',{displayName:n||'Member',countryCode:c});sound('success');toast('Profile saved')}catch(e){toast(e.message)}}
async function submitWithdrawal(){const amount=Number(document.querySelector('#amount').value),method=document.querySelector('#method').value,account=document.querySelector('#account').value.trim();try{const d=await api('withdraw',{amount,method,account});sound('success');toast(`Withdrawal submitted. ${fmt(d.pointsLocked)} points locked for review.`);document.querySelector('#amount').value='';document.querySelector('#account').value=''}catch(e){sound('error');toast(e.message)}}
async function dailyClaim(){try{const d=await api('claim-daily');sound('coin');toast(`+${d.reward} points added to your wallet.`);loadDaily()}catch(e){toast(e.message)}}
async function spinReward(){try{const d=await api('spin');sound('coin');toast(`Spin complete: +${d.reward} points.`)}catch(e){toast(e.message)}}
function referralLink(){return location.origin+'/index.html?ref='+encodeURIComponent(Z.profile?.referralCode||Z.uid)}
async function copyReferral(){try{await navigator.clipboard.writeText(referralLink());sound('click');toast('Referral link copied')}catch(e){toast(referralLink())}}
async function loadTasks(){
  const box=document.querySelector('#taskList');
  if(!box||!Z.uid)return;
  box.innerHTML='<div class="empty">Loading verified opportunities…</div>';
  try{
    const [ts, ss]=await Promise.all([
      ZDB.ref('tasks').once('value'),
      ZDB.ref('taskSubmissions/'+Z.uid).once('value')
    ]);
    const submissions=ss.val()||{};
    const all=Object.values(ts.val()||{})
      .filter(t=>t.status==='active'&&(!Array.isArray(t.countries)||!t.countries.length||t.countries.includes(Z.profile?.countryCode)))
      .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!all.length){
      box.innerHTML='<div class="empty">No verified opportunities are available for your region right now. Check back later.</div>';
      return;
    }
    box.innerHTML=all.map(t=>{
      const submittedId=submissions[t.id];
      const state=submittedId?'Submitted for review':'Available';
      return `<div class="card task">
        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="tag">${esc(t.category||'Opportunity')}</span>
            ${submittedId?'<span class="tag">PENDING REVIEW</span>':''}
          </div>
          <h3>${esc(t.title)}</h3>
          <p class="muted">${esc(t.instructions||'Verification required')}</p>
          <b class="reward">+${fmt(t.rewardPoints)} points</b>
          <small class="muted" style="display:block;margin-top:8px">${state}</small>
        </div>
        <button class="btn" ${submittedId?'disabled':''} onclick="startTask('${t.id}')">${submittedId?'Submitted':'Start'}</button>
      </div>`;
    }).join('');
  }catch(e){
    box.innerHTML='<div class="empty">Unable to load opportunities. Please refresh.</div>';
  }
}
async function startTask(id){const s=await ZDB.ref('tasks/'+id).once('value'),t=s.val();if(!t)return toast('Task unavailable');const proof=prompt(`${t.title}\n\n${t.instructions}\n\nPaste proof or completion link:`);if(!proof)return;try{if(t.url)window.open(t.url,'_blank','noopener');await api('task-submit',{taskId:id,proof});sound('success');toast('Task submitted for verification. Points are added only after approval.');loadTasks()}catch(e){toast(e.message)}}
async function loadTransactions(){const box=document.querySelector('#transactionList');if(!box)return;const s=await ZDB.ref('transactions/'+Z.uid).once('value');const a=Object.values(s.val()||{}).sort((x,y)=>(y.createdAt||0)-(x.createdAt||0));box.innerHTML=a.length?a.map(x=>`<div class="row"><div><b>${esc(x.description||x.type||'Transaction')}</b><p class="muted">${esc(x.status||'completed')} • ${x.createdAt?new Date(x.createdAt).toLocaleString():''}</p></div><div class="${x.direction==='debit'?'muted':'reward'}">${x.direction==='debit'?'-':'+'}${fmt(x.amount)} pts</div></div>`).join(''):'<div class="empty">No verified transactions yet.</div>'}
async function loadRewardedCampaigns(){const box=document.querySelector('#campaignList');if(!box)return;const s=await ZDB.ref('rewardedCampaigns').once('value');const a=Object.values(s.val()||{}).filter(x=>x.status==='active'&&(!Array.isArray(x.countries)||!x.countries.length||x.countries.includes(Z.profile?.countryCode)));box.innerHTML=a.length?a.map(x=>`<div class="card task"><div><span class="tag">APPROVED CAMPAIGN</span><h3>${esc(x.title)}</h3><p class="muted">${esc(x.description||'Verified partner opportunity')}</p><b class="reward">${x.rewardText?esc(x.rewardText):'Provider-defined reward'}</b></div>${x.url?`<a class="btn" target="_blank" rel="noopener" href="${esc(x.url)}">Open</a>`:''}</div>`).join(''):'<div class="empty">No approved rewarded campaigns are currently available in your region.</div>'}
async function loadLeaderboard(){const box=document.querySelector('#leaderboardList');if(!box)return;const s=await ZDB.ref('publicProfiles').orderByChild('earnedPoints').limitToLast(20).once('value');const a=Object.values(s.val()||{}).sort((x,y)=>(y.earnedPoints||0)-(x.earnedPoints||0));box.innerHTML=a.length?a.map((u,i)=>`<div class="row"><div><b>#${i+1} ${esc(u.displayName||'Member')}</b><p class="muted">${esc(u.countryCode||'Global')}</p></div><b class="reward">${fmt(u.earnedPoints)} pts</b></div>`).join(''):'<div class="empty">The leaderboard will populate from verified earnings.</div>'}
async function loadNotifications(){const box=document.querySelector('#notificationList');if(!box)return;const s=await ZDB.ref('notifications/'+Z.uid).once('value');const a=Object.values(s.val()||{}).sort((x,y)=>(y.createdAt||0)-(x.createdAt||0));box.innerHTML=a.length?a.map(n=>`<div class="row"><div><b>${esc(n.title)}</b><p class="muted">${esc(n.message)} • ${n.createdAt?new Date(n.createdAt).toLocaleString():''}</p></div><span class="tag">${esc(n.type||'info')}</span></div>`).join(''):'<div class="empty">No account notifications yet.</div>'}
async function loadReferrals(){const stats=document.querySelector('#referralStats');if(!stats)return;const s=await ZDB.ref('referrals/'+Z.uid).once('value');const a=Object.values(s.val()||{});const verified=a.filter(x=>x.status==='verified').length;stats.innerHTML=`<div class="card metric"><small>REGISTERED</small><b>${a.length}</b><span class="muted">Referrals</span></div><div class="card metric"><small>VERIFIED</small><b>${verified}</b><span class="muted">Eligible referrals</span></div><div class="card metric"><small>REFERRAL CODE</small><b>${esc(Z.profile?.referralCode||'—')}</b><span class="accent">Share responsibly</span></div>`}
function loadDaily(){const box=document.querySelector('#dailyStatus');if(!box)return;const today=new Date().toISOString().slice(0,10),claimed=Z.profile?.lastDailyClaim===today;box.innerHTML=claimed?'<div class="empty">Today’s daily reward has already been claimed. Come back after the next daily reset.</div>':'<div class="card metric"><small>STATUS</small><b>Available</b><span class="reward">One claim per account per day</span></div>'}
document.addEventListener('click',e=>{if(e.target.closest('button')||e.target.closest('.btn'))sound('click')});bindUser();

// Global authenticated UI helpers
function installAccountControls(){if(document.querySelector('[data-zyn-logout]'))return;const page=document.body?.dataset?.page;if(!page)return;const b=document.createElement('button');b.type='button';b.dataset.zynLogout='1';b.textContent='↪ Logout';b.title='Log out';b.style.cssText='position:fixed;right:18px;bottom:82px;z-index:9999;border:1px solid rgba(255,255,255,.16);background:#10243b;color:#fff;border-radius:12px;padding:10px 14px;font:600 13px system-ui;cursor:pointer;box-shadow:0 12px 30px rgba(0,0,0,.28)';b.onclick=logout;document.body.appendChild(b)}
document.addEventListener('DOMContentLoaded',installAccountControls);

async function loadDashboard(){
  try{
    const d=await api('account-summary');
    const locked=document.querySelector('[data-locked]'); if(locked)locked.textContent=fmt(d.pointsLocked);
    const pending=document.querySelector('[data-pending-withdrawals]'); if(pending)pending.textContent=fmt(d.pendingWithdrawalCount);
    const activity=document.querySelector('#recentActivity');
    if(activity){
      activity.innerHTML=d.recentTransactions.length?d.recentTransactions.slice(0,5).map(x=>`<div class="row"><div><b>${esc(x.description||x.type||'Activity')}</b><p class="muted">${esc(x.status||'completed')}</p></div><b class="${x.direction==='debit'?'muted':'reward'}">${x.direction==='debit'?'-':'+'}${fmt(x.amount)} pts</b></div>`).join(''):'<div class="empty">No verified account activity yet.</div>';
    }
  }catch(e){console.error('Dashboard summary:',e)}
}
async function loadWallet(){
  try{
    const d=await api('account-summary');
    const locked=document.querySelector('[data-locked]'); if(locked)locked.textContent=fmt(d.pointsLocked);
    const pending=document.querySelector('[data-pending-withdrawals]'); if(pending)pending.textContent=fmt(d.pendingWithdrawalCount);
    const history=document.querySelector('#walletWithdrawalHistory');
    if(history){
      history.innerHTML=d.recentWithdrawals.length?d.recentWithdrawals.slice(0,5).map(w=>`<div class="row"><div><b>${esc(String(w.amount))} ${esc(countryCfg().currency)} • ${esc(w.method)}</b><p class="muted">${esc(w.status)} • ${w.createdAt?new Date(w.createdAt).toLocaleString():''}</p></div><span class="tag">${esc(w.status)}</span></div>`).join(''):'<div class="empty">No withdrawal requests yet.</div>';
    }
  }catch(e){console.error('Wallet summary:',e)}
}
async function loadWithdrawalHistory(){
  const box=document.querySelector('#withdrawalHistory'); if(!box)return;
  try{
    const d=await api('withdrawal-history');
    box.innerHTML=d.items.length?d.items.map(w=>`<div class="row"><div><b>${esc(String(w.amount))} ${esc(countryCfg().currency)} via ${esc(w.method)}</b><p class="muted">${esc(w.status)}${w.reviewNote?' • '+esc(w.reviewNote):''}</p></div><span class="tag">${esc(w.status)}</span></div>`).join(''):'<div class="empty">Your payout requests will appear here after submission.</div>';
  }catch(e){box.innerHTML='<div class="empty">Unable to load withdrawal history.</div>'}
}
