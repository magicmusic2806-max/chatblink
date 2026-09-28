document.querySelectorAll(".google-button").forEach(button=>button.remove());
document.querySelectorAll(".auth-pane .divider").forEach(divider=>divider.remove());

const signupForm=$("#signupForm");
["age","gender","email"].forEach(name=>signupForm.elements[name]?.closest("label")?.remove());
signupForm.querySelector(".form-grid").style.gridTemplateColumns="1fr";
signupForm.querySelector("[name=username]").placeholder="Choose a username";
$("#signupPane header p").textContent="Choose a username and password to enter chat.";

const loginIdentifier=$("#loginForm [name=identifier]");
loginIdentifier.placeholder="Your username";
const loginLabel=loginIdentifier.closest("label");
loginLabel.childNodes[0].textContent="Username";

signupForm.onsubmit=async event=>{
 event.preventDefault();const form=event.currentTarget,data=new FormData(form);showError("#signupError","");setBusy(form,true);
 try{
  const result=await request("/api/auth/signup",{method:"POST",body:JSON.stringify({username:data.get("username"),password:data.get("password"),adultConfirmed:data.get("adultConfirmed")==="on"})});
  enterChat(result.user);toast("Account created. Welcome to Global.");
 }catch(error){showError("#signupError",error.message)}finally{setBusy(form,false)}
};
