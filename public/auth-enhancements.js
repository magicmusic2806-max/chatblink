let pendingEmail="";

$("#signupForm").onsubmit=async event=>{
 event.preventDefault();const form=event.currentTarget,data=new FormData(form);showError("#signupError","");setBusy(form,true);
 try{
  const result=await request("/api/auth/signup",{method:"POST",body:JSON.stringify({username:data.get("username"),age:Number(data.get("age")),email:data.get("email"),gender:data.get("gender"),password:data.get("password"),adultConfirmed:data.get("adultConfirmed")==="on"})});
  pendingEmail=result.email;showVerificationPending(result.email);form.reset();
 }catch(error){showError("#signupError",error.message)}finally{setBusy(form,false)}
};

function showVerificationPending(email){
 let panel=$("#verificationPending");
 if(!panel){
  panel=document.createElement("div");panel.id="verificationPending";panel.className="verification-pending";
  panel.innerHTML='<span class="mail-icon">✉</span><h3>Check your inbox</h3><p>We sent a verification link to <strong id="pendingEmail"></strong>. It expires in 30 minutes.</p><button type="button" id="resendVerification">Resend verification email</button>';
  $("#signupPane").appendChild(panel);
  $("#resendVerification").onclick=resendVerification;
 }
 $("#pendingEmail").textContent=email;$("#signupPane header").hidden=true;$("#signupPane .google-button")?.setAttribute("hidden","");$("#signupPane .google-signin-host")?.setAttribute("hidden","");$("#signupPane .divider").hidden=true;$("#signupForm").hidden=true;$("#signupPane .switch-copy").hidden=true;panel.hidden=false;
}
async function resendVerification(){
 const button=$("#resendVerification");button.disabled=true;button.textContent="Sending…";
 try{await request("/api/auth/resend-verification",{method:"POST",body:JSON.stringify({email:pendingEmail})});toast("A new verification email was sent.")}catch(error){toast(error.message)}finally{button.disabled=false;button.textContent="Resend verification email"}
}

async function installOfficialGoogleButtons(){
 const config=await request("/api/config").catch(()=>({}));
 if(!config.googleClientId)return;
 const waitForGoogle=()=>new Promise((resolve,reject)=>{let checks=0;const timer=setInterval(()=>{if(window.google?.accounts?.id){clearInterval(timer);resolve()}else if(++checks>80){clearInterval(timer);reject()}},100)});
 try{
  await waitForGoogle();
  google.accounts.id.initialize({client_id:config.googleClientId,callback:response=>{googleAction=$("#signupPane").classList.contains("active")?"signup":"login";handleGoogleCredential(response)}});
  document.querySelectorAll(".google-button").forEach(button=>{
   const host=document.createElement("div");host.className="google-signin-host";host.dataset.googleAction=button.dataset.googleAction;button.replaceWith(host);
   google.accounts.id.renderButton(host,{type:"standard",theme:"outline",size:"large",shape:"rectangular",text:host.dataset.googleAction==="signup"?"signup_with":"continue_with",width:400,logo_alignment:"left"});
  });
 }catch{}
}
installOfficialGoogleButtons();

const query=new URLSearchParams(location.search);
if(query.get("verified")==="1"){setTimeout(()=>toast("Email verified. Welcome to Global."),500);history.replaceState({},"",location.pathname)}
if(query.get("verification")==="invalid"){switchAuth("signup");showError("#signupError","That verification link is invalid or has expired. Sign up again or request another email.");history.replaceState({},"",location.pathname)}

const enhancementStyle=document.createElement("style");
enhancementStyle.textContent='.verification-pending{text-align:center;padding:28px 10px}.verification-pending .mail-icon{display:grid;place-items:center;width:58px;height:58px;margin:0 auto 15px;border-radius:18px;background:#e9edff;color:#446df6;font-size:1.6rem}.verification-pending h3{margin:0 0 8px;font:800 1.35rem Manrope}.verification-pending p{max-width:390px;margin:0 auto 20px;color:#697386;line-height:1.55}.verification-pending button{height:44px;border:1px solid #d5dae6;border-radius:10px;background:#fff;color:#446df6;padding:0 16px;font-weight:700;cursor:pointer}.verification-pending button:disabled{opacity:.6}.google-signin-host{min-height:44px;display:flex;justify-content:center;overflow:hidden}.google-signin-host>div{max-width:100%}';
document.head.appendChild(enhancementStyle);
