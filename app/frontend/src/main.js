import { PublicClientApplication } from "@azure/msal-browser";

const config = await fetch("/config.json").then((r) => r.json());

const msal = new PublicClientApplication({
  auth: {
    clientId: config.clientId,
    authority: `https://login.microsoftonline.com/${config.tenantId}`,
    redirectUri: window.location.origin,
  },
  cache: { cacheLocation: "sessionStorage" },
});

await msal.initialize();
await msal.handleRedirectPromise();

const statusEl = document.getElementById("status");
const signinBtn = document.getElementById("btn-signin");
const signoutBtn = document.getElementById("btn-signout");

function getAccount() {
  const accounts = msal.getAllAccounts();
  return accounts.length > 0 ? accounts[0] : null;
}

async function getToken() {
  const account = getAccount();
  const request = {
    scopes: [`api://${config.clientId}/access_as_user`],
    account,
  };
  try {
    return await msal.acquireTokenSilent(request);
  } catch {
    return await msal.acquireTokenRedirect(request);
  }
}

async function fetchMe(token) {
  const res = await fetch(`${config.apiUrl}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

async function updateUI() {
  const account = getAccount();
  if (!account) {
    signinBtn.style.display = "";
    signoutBtn.style.display = "none";
    statusEl.textContent = "Not signed in.";
    return;
  }

  signinBtn.style.display = "none";
  signoutBtn.style.display = "";
  statusEl.textContent = `Signed in as ${account.name} — fetching profile…`;

  try {
    const tokenResp = await getToken();
    const me = await fetchMe(tokenResp.accessToken);
    statusEl.textContent = `Signed in as ${account.name} (oid: ${me.oid})`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

signinBtn.addEventListener("click", () =>
  msal.loginRedirect({ scopes: [`api://${config.clientId}/access_as_user`] })
);

signoutBtn.addEventListener("click", () =>
  msal.logoutRedirect({ account: getAccount() })
);

updateUI();
