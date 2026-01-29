import { useEffect, useMemo, useRef, useState } from "react";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

const decodeJwt = (token) => {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized);
    return JSON.parse(decoded);
  } catch (err) {
    return null;
  }
};

const useGoogleReady = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      if (window.google?.accounts?.id) {
        setReady(true);
        return;
      }
      if (attempts < 40) {
        setTimeout(tick, 150);
      }
    };
    tick();
  }, []);

  return ready;
};

export default function App() {
  const [credential, setCredential] = useState("");
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [backendStatus, setBackendStatus] = useState(null);
  const [userId, setUserId] = useState("");
  const [connected, setConnected] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const oauthGroupRef = useRef(null);
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      text: "Welcome! Ask me to summarize emails or prepare a calendar agenda.",
      time: "09:12",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const chatEndRef = useRef(null);
  const chatWindowRef = useRef(null);
  const ready = useGoogleReady();

  const clientMissing = useMemo(() => CLIENT_ID.trim().length === 0, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("workspaceai.session");
    if (!stored) return;
    try {
      const payload = JSON.parse(stored);
      if (payload.credential) setCredential(payload.credential);
      if (payload.profile) setProfile(payload.profile);
      if (payload.userId) setUserId(payload.userId);
    } catch (err) {
      window.localStorage.removeItem("workspaceai.session");
    }
  }, []);

  useEffect(() => {
    if (!credential && !profile && !userId) {
      window.localStorage.removeItem("workspaceai.session");
      return;
    }
    window.localStorage.setItem(
      "workspaceai.session",
      JSON.stringify({ credential, profile, userId })
    );
  }, [credential, profile, userId]);

  useEffect(() => {
    if (!ready || clientMissing) return;

    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response) => {
        setError("");
        setCredential(response.credential);
        setProfile(decodeJwt(response.credential));
      },
    });

    window.google.accounts.id.renderButton(
      document.getElementById("google-signin"),
      {
        theme: "outline",
        size: "large",
        shape: "pill",
        width: Math.min(400, oauthGroupRef.current?.offsetWidth || 400),
      }
    );

    window.google.accounts.id.prompt();
  }, [ready, clientMissing]);

  useEffect(() => {
    if (!credential) return;

    const verify = async () => {
      setBackendStatus({ state: "loading" });
      try {
        const response = await fetch(`${BACKEND_URL}/auth/google`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id_token: credential }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail || "Backend verification failed");
        }

        const payload = await response.json();
        setBackendStatus({ state: "ok", payload });
        const id = payload.user_id || "";
        setUserId(id);
        if (id) {
          fetch(`${BACKEND_URL}/auth/google/status?user_id=${id}`)
            .then((res) => res.json())
            .then((data) => setConnected(Boolean(data.connected)))
            .catch(() => setConnected(false));
        }
      } catch (err) {
        setBackendStatus({ state: "error", message: err.message });
      }
    };

    verify();
  }, [credential]);

  const resetSession = () => {
    setCredential("");
    setProfile(null);
    setError("");
    setBackendStatus(null);
    setConnected(false);
    setUserId("");
    window.localStorage.removeItem("workspaceai.session");
    window.google?.accounts?.id?.disableAutoSelect();
  };

  const connectGoogle = async () => {
    if (!userId) return;
    try {
      const response = await fetch(
        `${BACKEND_URL}/auth/google/authorize?user_id=${userId}`
      );
      const payload = await response.json();
      if (payload.auth_url) {
        window.location.href = payload.auth_url;
      }
    } catch (err) {
      setError("Failed to start Google authorization.");
    }
  };

  const sendMessage = (event) => {
    event.preventDefault();
    if (!draft.trim()) return;
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const next = {
      id: `${now.getTime()}`,
      role: "user",
      text: draft.trim(),
      time,
    };
    setMessages((prev) => [...prev, next]);
    setDraft("");
    setIsResponding(true);

    if (!userId) {
      setIsResponding(false);
      return;
    }

    fetch(`${BACKEND_URL}/api/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: next.text, user_id: userId }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail || "Chat request failed");
        }
        return response.json();
      })
      .then((payload) => {
        const reply =
          payload.summary ||
          JSON.stringify(payload.results || payload, null, 2) ||
          "I completed that request. Let me know what to do next.";
        setMessages((prev) => [
          ...prev,
          { id: `${now.getTime()}-reply`, role: "assistant", text: reply, time },
        ]);
        setIsResponding(false);
      })
      .catch((err) => {
        setMessages((prev) => [
          ...prev,
          {
            id: `${now.getTime()}-reply`,
            role: "assistant",
            text: err.message || "Something went wrong.",
            time,
          },
        ]);
        setIsResponding(false);
      });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google_connected") === "1") {
      setConnected(true);
      // clean URL
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    if (!chatWindowRef.current) return;
    chatWindowRef.current.scrollTo({
      top: chatWindowRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isResponding]);

  const handleChatKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim()) {
        sendMessage(event);
      }
    }
  };

  if (profile) {
    return (
      <div className="page home">
        <header className="hero">
          <div className="logo">WorkspaceAI</div>
          <nav className="meta">
            <span>Home</span>
            <span className="dot" />
            <span>{profile.email}</span>
          </nav>
        </header>

        <main className="home-grid">
          <section className="card profile-card">
            <h2>Workspace profile</h2>
            <div className="profile">
              <div className="avatar">
                {profile.name?.trim().charAt(0).toUpperCase() || "U"}
              </div>
              <div>
                <div className="name">{profile.name}</div>
                <span className="chip">Google verified</span>
              </div>
            </div>

            {backendStatus?.state === "ok" ? (
              <div className="status success">Backend: {BACKEND_URL}</div>
            ) : backendStatus?.state === "error" ? (
              <div className="status error">
                {backendStatus.message || "Backend verification failed."}
              </div>
            ) : (
              <div className="status">Checking backend status…</div>
            )}

            <div className="connect-row">
              <span className="muted">
                {connected ? "Workspace access connected." : "Workspace access required."}
              </span>
              <button
                className="primary"
                type="button"
                onClick={connectGoogle}
                disabled={connected}
              >
                {connected ? "Connected" : "Connect Google"}
              </button>
            </div>

            <div className="profile-divider" />

            <div className="embedded-board">
              <h3>Today’s focus</h3>
              <ul>
                <li>Review unread Gmail summaries</li>
                <li>Prepare next week’s calendar agenda</li>
                <li>Outline the product update doc</li>
              </ul>
            </div>

            <button className="ghost" onClick={resetSession}>
              Sign out
            </button>
          </section>

          <section className="card chat">
            <div className="chat-header">
              <div>
                <h2>Assistant chat</h2>
                <p className="muted">Ask about Gmail, Calendar, Docs, and tasks.</p>
              </div>
              <div className="chip soft">Lo-fi mode</div>
            </div>

            <div className="chat-window" ref={chatWindowRef}>
              {messages.map((msg) => (
                <div key={msg.id} className={`bubble ${msg.role}`}>
                  <p>{msg.text}</p>
                  <span>{msg.time}</span>
                </div>
              ))}
              {isResponding && (
                <div className="responding">
                  Responding<span>.</span>
                  <span>.</span>
                  <span>.</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form className="chat-input" onSubmit={sendMessage}>
              <textarea
                rows={2}
                placeholder="Draft a reply to the last email from Dana..."
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleChatKeyDown}
              />
              <button type="submit" className="primary">
                Send
              </button>
            </form>
          </section>

          <section className="card activity">
            <h2>Recent activity</h2>
            <ul className="activity-list">
              <li>
                <span className="activity-dot" />
                Drafted an email to product team
                <span className="activity-time">2m ago</span>
              </li>
              <li>
                <span className="activity-dot" />
                Created a new project kickoff doc
                <span className="activity-time">18m ago</span>
              </li>
              <li>
                <span className="activity-dot" />
                Scheduled a follow-up on Calendar
                <span className="activity-time">1h ago</span>
              </li>
            </ul>
            <div className="board-note">
              Activity will update as you use Gmail, Docs, and Calendar.
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="logo">WorkspaceAI</div>
        <nav className="meta">
          <span>Workspace access</span>
          <span className="dot" />
          <span>Version 0.1</span>
        </nav>
      </header>

      <main className="content">
        <section className="story">
          <p className="tag">Your Google workspace, softly arranged.</p>
          <h1>Sign in to your calm assistant.</h1>
          <p className="lede">
            An agent that helps you with Gmail, Calendar, Docs, and more. Start
            with an email or use Google to drop right in.
          </p>
          <div className="pill-row">
            <span>Gmail</span>
            <span>Calendar</span>
            <span>Docs</span>
            <span>Drive</span>
          </div>
          <div className="ambient">
            <div className="grain" />
            <div className="orb orb-one" />
            <div className="orb orb-two" />
            <div className="orb orb-three" />
          </div>
        </section>

        <section className="card auth">
          <div className="tabs">
            <button
              type="button"
              className={`tab ${authMode === "signin" ? "active" : ""}`}
              onClick={() => setAuthMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`tab ${authMode === "register" ? "active" : ""}`}
              onClick={() => setAuthMode("register")}
            >
              Register
            </button>
          </div>

          {authMode === "signin" ? (
            <form className="form">
              <label>
                Email
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={emailInput}
                  onChange={(event) => setEmailInput(event.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder="••••••••"
                  value={passwordInput}
                  onChange={(event) => setPasswordInput(event.target.value)}
                />
              </label>
              <button type="button" className="primary">
                Sign in with email
              </button>
            </form>
          ) : (
            <form className="form">
              <label>
                Email
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={registerEmail}
                  onChange={(event) => setRegisterEmail(event.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder="Create a password"
                  value={registerPassword}
                  onChange={(event) => setRegisterPassword(event.target.value)}
                />
              </label>
              <button type="button" className="primary">
                Create account
              </button>
            </form>
          )}

          <div className="divider">
            <span>or</span>
          </div>

          <div className="oauth-group" ref={oauthGroupRef}>
            {clientMissing ? (
              <div className="warning">
                <strong>Missing client ID.</strong> Add it to{" "}
                <code>.env</code> as <code>VITE_GOOGLE_CLIENT_ID</code>.
              </div>
            ) : (
              <div id="google-signin" className="google-button" />
            )}
          </div>

          {error && <div className="error">{error}</div>}

          {backendStatus?.state === "loading" && (
            <div className="status">Verifying with backend…</div>
          )}
          {backendStatus?.state === "ok" && (
            <div className="status success">
              Backend verified {backendStatus.payload.email}.
            </div>
          )}
          {backendStatus?.state === "error" && (
            <div className="status error">
              {backendStatus.message || "Backend verification failed."}
            </div>
          )}

          {credential && (
            <button className="ghost" onClick={resetSession}>
              Clear session
            </button>
          )}
        </section>
      </main>
    </div>
  );
}
