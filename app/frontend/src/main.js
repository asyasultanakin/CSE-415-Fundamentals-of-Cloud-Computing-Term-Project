import { PublicClientApplication } from "@azure/msal-browser";

const config = await fetch("/config.json").then((r) => r.json());

// GA4 — load tag and expose gtag
if (config.ga4Id) {
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${config.ga4Id}`;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag("js", new Date());
  gtag("config", config.ga4Id);
}

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

const statusEl       = document.getElementById("status");
const uploadStatusEl = document.getElementById("upload-status");
const signinBtn      = document.getElementById("btn-signin");
const signoutBtn     = document.getElementById("btn-signout");
const uploadSection  = document.getElementById("upload-section");
const fileInput      = document.getElementById("file-input");
const uploadBtn      = document.getElementById("btn-upload");
const refreshBtn     = document.getElementById("btn-refresh");
const gallery        = document.getElementById("gallery");

function getAccount() {
  const accounts = msal.getAllAccounts();
  return accounts.length > 0 ? accounts[0] : null;
}

async function getToken() {
  const account = getAccount();
  const request = { scopes: [`api://${config.clientId}/access_as_user`], account };
  try {
    return await msal.acquireTokenSilent(request);
  } catch {
    return await msal.acquireTokenRedirect(request);
  }
}

async function apiFetch(path, options = {}) {
  const tokenResp = await getToken();
  return fetch(`${config.apiUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${tokenResp.accessToken}`, ...options.headers },
  });
}

async function loadGallery() {
  gallery.innerHTML = "<p style='color:#888'>Loading…</p>";
  try {
    const res = await apiFetch("/api/photos");
    if (!res.ok) throw new Error(res.status);
    const { photos } = await res.json();
    if (photos.length === 0) {
      gallery.innerHTML = "<p style='color:#888'>No photos yet. Upload one!</p>";
      return;
    }
    gallery.innerHTML = "";
    for (const photo of photos) {
      const card = document.createElement("div");
      card.className = "photo-card";
      const badgeClass = photo.status === "PROCESSED" ? "badge-processed" : "badge-pending";
      card.innerHTML = `
        <img src="${photo.viewUrl}" alt="photo" loading="lazy" onerror="this.style.display='none'" />
        <div class="info">
          <span class="badge ${badgeClass}">${photo.status}</span>
          <div style="margin-top:4px">${new Date(photo.createdAt).toLocaleString()}</div>
          ${photo.sizeBytes ? `<div>${(photo.sizeBytes / 1024).toFixed(1)} KB</div>` : ""}
        </div>`;
      gallery.appendChild(card);
    }
  } catch (err) {
    gallery.innerHTML = `<p style='color:red'>Error loading gallery: ${err.message}</p>`;
  }
}

uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = "";

  uploadStatusEl.textContent = "Requesting upload URL…";
  uploadBtn.disabled = true;

  try {
    const res = await apiFetch("/api/photos/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type, size: file.size }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? res.status);
    }
    const { uploadUrl } = await res.json();

    uploadStatusEl.textContent = "Uploading…";
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!put.ok) throw new Error(`S3 upload failed: ${put.status}`);

    // Fire GA4 custom event
    if (typeof gtag === "function") {
      gtag("event", "upload_photo", { file_type: file.type, file_size: file.size });
    }

    uploadStatusEl.textContent = "Upload complete! Refreshing gallery…";
    // Give Lambda a moment then refresh
    setTimeout(loadGallery, 2000);
  } catch (err) {
    uploadStatusEl.textContent = `Upload failed: ${err.message}`;
  } finally {
    uploadBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", loadGallery);

async function updateUI() {
  const account = getAccount();
  if (!account) {
    signinBtn.style.display = "";
    signoutBtn.style.display = "none";
    uploadSection.style.display = "none";
    statusEl.textContent = "Not signed in.";
    gallery.innerHTML = "";
    return;
  }

  signinBtn.style.display = "none";
  signoutBtn.style.display = "";
  uploadSection.style.display = "block";
  statusEl.textContent = `Signed in as ${account.name}`;

  loadGallery();
}

signinBtn.addEventListener("click", () =>
  msal.loginRedirect({ scopes: [`api://${config.clientId}/access_as_user`] })
);

signoutBtn.addEventListener("click", () =>
  msal.logoutRedirect({ account: getAccount() })
);

updateUI();
