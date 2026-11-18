/**
 * ============================================================================
 * VERITAS FRONTEND — DOCUMENT INTELLIGENCE & VERIFICATION
 * Vanilla ES6 Architecture (No Frameworks, No Build Step)
 * ============================================================================
 */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // APPLICATION STATE
  // --------------------------------------------------------------------------
  const state = {
    currentView: 'chat',
    tenant: 'demo-workspace',
    user: 'demo-operator',
    isAdmin: true,
    currentConversationId: null,
    conversations: [], // [{ id, title, updatedAt }]
    currentSources: [], // Sources from the most recent assistant answer
    documents: [],
    pollingInterval: null,
    pendingFeedbackDocId: null,
    pendingFeedbackRating: 0
  };

  // --------------------------------------------------------------------------
  // SECTION 1: API CLIENT
  // --------------------------------------------------------------------------
  const api = {
    async checkHealth() {
      try {
        const res = await fetch('/health/live');
        return res.ok;
      } catch {
        return false;
      }
    },

    async ask(question, conversationId) {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          conversation_id: conversationId || null
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const err = new Error(errData.detail || `Server error (${res.status})`);
        err.status = res.status;
        err.detail = errData.detail;
        throw err;
      }
      return res.json();
    },

    async getConversationMessages(conversationId) {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) throw new Error('Failed to retrieve conversation history');
      return res.json();
    },

    async submitFeedback(documentId, rating, note = '') {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_id: documentId || null,
          rating,
          note
        })
      });
      if (!res.ok) throw new Error('Failed to submit feedback');
      return res.json();
    },

    async createUploadUrl(filename) {
      const res = await fetch('/api/documents/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Could not initiate document upload');
      }
      return res.json();
    },

    async uploadToS3(uploadUrl, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        if (xhr.upload && onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              onProgress(percent);
            }
          };
        }

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`S3 upload failed with HTTP status ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('Network error uploading directly to S3. Check bucket CORS.'));
        xhr.send(file);
      });
    },

    async completeUpload(documentId) {
      const res = await fetch('/api/documents/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: documentId })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Document processing completion failed');
      }
      return res.json();
    },

    async getDocuments() {
      const res = await fetch('/api/documents');
      if (!res.ok) throw new Error('Failed to list workspace documents');
      return res.json();
    },

    async getApprovals() {
      const res = await fetch('/api/approvals');
      if (!res.ok) {
        if (res.status === 403) throw new Error('Admin privileges required to view approvals');
        throw new Error('Failed to retrieve approvals queue');
      }
      return res.json();
    },

    async decideApproval(approvalId, approve) {
      const res = await fetch(`/api/approvals/${approvalId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve })
      });
      if (!res.ok) throw new Error('Failed to record approval decision');
      return res.json();
    },

    async getAdminMetrics() {
      const res = await fetch('/api/admin/metrics');
      if (!res.ok) throw new Error('Failed to fetch admin metrics');
      return res.json();
    },

    async getAdminGuardrails() {
      const res = await fetch('/api/admin/guardrails');
      if (!res.ok) throw new Error('Failed to fetch guardrails telemetry');
      return res.json();
    }
  };

  // --------------------------------------------------------------------------
  // SANITIZATION & MARKDOWN FORMATTER
  // --------------------------------------------------------------------------
  function escapeHtml(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, (m) => map[m]);
  }

  function renderSanitizedAnswer(text) {
    if (!text) return '';

    // Step 1: Escape all raw characters to neutralize XSS
    let safe = escapeHtml(text);

    // Step 2: Code blocks
    safe = safe.replace(/```([\s\S]*?)```/g, (match, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Step 3: Inline code
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Step 4: Bold and italics
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Step 5: Citation pill replacement: e.g. [1], [2], or [1, 2]
    safe = safe.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (match, nums) => {
      const pills = nums.split(',').map((n) => {
        const num = n.trim();
        return `<button type="button" class="citation-pill" data-source-index="${num}" title="View source passage ${num}">[${num}]</button>`;
      });
      return pills.join(' ');
    });

    // Step 6: Convert double linebreaks to paragraphs, single to br
    const paragraphs = safe.split(/\n\n+/);
    return paragraphs.map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  }

  // --------------------------------------------------------------------------
  // TOAST NOTIFICATIONS
  // --------------------------------------------------------------------------
  function showToast(message, type = 'normal') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  // --------------------------------------------------------------------------
  // SECTION 2: SHELL & NAVIGATION
  // --------------------------------------------------------------------------
  function initShell() {
    // Navigation tab switching
    const navTabs = document.querySelectorAll('.nav-tab');
    navTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetView = tab.getAttribute('data-view');
        switchView(targetView);
      });
    });

    // Theme toggle
    const themeBtn = document.getElementById('theme-toggle');
    const sunIcon = document.getElementById('theme-icon-sun');
    const moonIcon = document.getElementById('theme-icon-moon');

    const savedTheme = localStorage.getItem('veritas_theme') || 'light';
    applyTheme(savedTheme);

    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('veritas_theme', next);
    });

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      if (theme === 'dark') {
        sunIcon.style.display = 'none';
        moonIcon.style.display = 'block';
      } else {
        sunIcon.style.display = 'block';
        moonIcon.style.display = 'none';
      }
    }

    // Health check loop
    checkSystemStatus();
    setInterval(checkSystemStatus, 30000);
  }

  async function checkSystemStatus() {
    const isLive = await api.checkHealth();
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (dot && text) {
      if (isLive) {
        dot.classList.remove('offline');
        text.textContent = 'Connected';
      } else {
        dot.classList.add('offline');
        text.textContent = 'Backend Offline';
      }
    }
  }

  function switchView(viewName) {
    state.currentView = viewName;

    // Update active tab button
    document.querySelectorAll('.nav-tab').forEach((tab) => {
      if (tab.getAttribute('data-view') === viewName) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Update active screen section
    document.querySelectorAll('.screen-view').forEach((screen) => {
      if (screen.id === `view-${viewName}`) {
        screen.classList.add('active-view');
      } else {
        screen.classList.remove('active-view');
      }
    });

    // Trigger view-specific loads
    if (viewName === 'documents') {
      loadDocuments();
    } else if (viewName === 'approvals') {
      loadApprovals();
    } else if (viewName === 'admin') {
      loadAdminDashboard();
    }
  }

  // --------------------------------------------------------------------------
  // SECTION 3: CHAT SCREEN & CITATION EXPERIENCE
  // --------------------------------------------------------------------------
  function initChat() {
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const charCounter = document.getElementById('char-counter');
    const newChatBtn = document.getElementById('btn-new-chat');
    const closeSourcePanelBtn = document.getElementById('close-source-panel');

    // Load stored conversations
    loadStoredConversations();

    // Textarea auto-resize and counter
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      charCounter.textContent = `${input.value.length} / 2000`;
    });

    // Enter to submit (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    // Prompt chip suggestion clicks
    document.querySelectorAll('.prompt-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        input.value = chip.getAttribute('data-prompt') || '';
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
    });

    // Form submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question || question.length < 3) {
        showToast('Questions must be at least 3 characters long', 'error');
        return;
      }

      input.value = '';
      input.style.height = 'auto';
      charCounter.textContent = '0 / 2000';

      // Hide empty state
      const emptyState = document.getElementById('chat-empty-state');
      if (emptyState) emptyState.style.display = 'none';

      // Append user message
      appendUserMessage(question);

      // Append assistant loading placeholder
      const loadingBubble = appendAssistantLoading();

      try {
        const response = await api.ask(question, state.currentConversationId);

        // Update conversation ID
        if (response.conversation_id) {
          state.currentConversationId = response.conversation_id;
          saveConversationToStorage(response.conversation_id, question);
        }

        // Remove loading
        loadingBubble.remove();

        // Render assistant reply based on status
        renderAssistantResponse(response);
      } catch (err) {
        loadingBubble.remove();
        renderErrorMessage(err.message || 'An unexpected error occurred.');
      }
    });

    // New conversation button
    newChatBtn.addEventListener('click', () => {
      startNewConversation();
    });

    // Close source panel
    closeSourcePanelBtn.addEventListener('click', () => {
      closeSourcePanel();
    });

    // Global listener for citation pills in messages
    document.getElementById('chat-messages').addEventListener('click', (e) => {
      const pill = e.target.closest('.citation-pill');
      if (pill) {
        const index = parseInt(pill.getAttribute('data-source-index'), 10);
        activateCitation(index, pill);
      }
    });
  }

  function startNewConversation() {
    state.currentConversationId = null;
    state.currentSources = [];
    const container = document.getElementById('chat-messages');
    container.innerHTML = `
      <div class="chat-empty-state" id="chat-empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <h2>Grounded Intelligence</h2>
        <p>Ask questions about your uploaded documents. Every answer is substantiated with interactive citations and verifiable source passages.</p>
        <div class="suggested-prompts">
          <button type="button" class="prompt-chip" data-prompt="What documents are available in this workspace?">What documents are available in this workspace?</button>
          <button type="button" class="prompt-chip" data-prompt="Summarize the key policies described in our documents.">Summarize the key policies described in our documents.</button>
          <button type="button" class="prompt-chip" data-prompt="Delete all old document versions">Delete all old document versions (Triggers approval)</button>
        </div>
      </div>
    `;

    // Re-bind chip clicks
    document.querySelectorAll('.prompt-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        input.value = chip.getAttribute('data-prompt') || '';
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
    });

    closeSourcePanel();
    renderConversationList();
  }

  function appendUserMessage(text) {
    const container = document.getElementById('chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row user-row';
    row.innerHTML = `<div class="message-bubble user-bubble">${escapeHtml(text)}</div>`;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function appendAssistantLoading() {
    const container = document.getElementById('chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row assistant-row';
    row.innerHTML = `
      <div class="message-bubble assistant-bubble">
        <div style="display:flex; align-items:center; gap:8px; font-family:var(--font-sans); color:var(--ink-muted); font-size:13px;">
          <span class="status-dot" style="animation: pulse 1s infinite;"></span>
          <span>Searching grounded evidence and generating verified response...</span>
        </div>
      </div>
    `;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  function renderAssistantResponse(response) {
    const container = document.getElementById('chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row assistant-row';

    // Store sources
    state.currentSources = response.sources || [];
    renderSourcesInPanel(state.currentSources);

    let contentHtml = '';

    if (response.status === 'pending_approval') {
      contentHtml = `
        <div class="chat-alert-card alert-amber">
          <div class="alert-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="alert-content">
            <strong>Administrator Approval Required</strong>
            <p>${escapeHtml(response.answer)}</p>
            <div class="alert-btn">
              <button type="button" class="btn btn-secondary btn-sm" onclick="window.VeritasApp.switchView('approvals')">
                View in Approvals tab
              </button>
            </div>
          </div>
        </div>
      `;
    } else if (response.status === 'guardrail_blocked') {
      contentHtml = `
        <div class="chat-alert-card alert-brick">
          <div class="alert-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div class="alert-content">
            <strong>Sensitive Content Redacted</strong>
            <p>${escapeHtml(response.answer)}</p>
          </div>
        </div>
      `;
    } else {
      // Normal or no_evidence response
      contentHtml = renderSanitizedAnswer(response.answer);
    }

    row.innerHTML = `
      <div class="message-bubble assistant-bubble">
        <div class="bubble-text">${contentHtml}</div>
        <div class="assistant-actions">
          <span>${response.sources && response.sources.length ? `${response.sources.length} sources cited` : 'Direct response'}</span>
          <div class="feedback-buttons">
            <button type="button" class="feedback-btn" data-rating="1" title="Helpful response">
              👍 Helpful
            </button>
            <button type="button" class="feedback-btn" data-rating="-1" title="Unhelpful response">
              👎 Unhelpful
            </button>
          </div>
        </div>
      </div>
    `;

    // Attach feedback handlers
    const thumbUp = row.querySelector('[data-rating="1"]');
    const thumbDown = row.querySelector('[data-rating="-1"]');
    if (thumbUp) thumbUp.addEventListener('click', () => openFeedbackModal(1));
    if (thumbDown) thumbDown.addEventListener('click', () => openFeedbackModal(-1));

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function renderErrorMessage(errorText) {
    const container = document.getElementById('chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row assistant-row';
    row.innerHTML = `
      <div class="chat-alert-card alert-brick">
        <div class="alert-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        </div>
        <div class="alert-content">
          <strong>Request Not Completed</strong>
          <p>${escapeHtml(errorText)}</p>
        </div>
      </div>
    `;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  // Citation Activation & Source Passage Panel
  function activateCitation(index, clickedPill) {
    const panel = document.getElementById('source-panel');
    panel.classList.add('panel-open');

    // Update pill highlight
    document.querySelectorAll('.citation-pill').forEach((p) => p.classList.remove('active'));
    if (clickedPill) clickedPill.classList.add('active');

    // Highlight passage card
    document.querySelectorAll('.passage-card').forEach((card) => {
      card.classList.remove('passage-active');
      if (parseInt(card.getAttribute('data-passage-index'), 10) === index) {
        card.classList.add('passage-active');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function renderSourcesInPanel(sources) {
    const container = document.getElementById('source-passages-list');
    if (!sources || sources.length === 0) {
      container.innerHTML = `
        <div class="empty-sources">
          No external source passages were cited in this turn.
        </div>
      `;
      return;
    }

    container.innerHTML = sources.map((src) => `
      <div class="passage-card" data-passage-index="${src.index}">
        <div class="passage-header">
          <span class="passage-index">[${src.index}]</span>
          <span class="passage-title" title="${escapeHtml(src.title)}">${escapeHtml(src.title || 'Untitled Document')}</span>
        </div>
        <div class="passage-meta">Page ${src.page || 1}</div>
        <div class="passage-text">"${escapeHtml(src.excerpt || 'No excerpt available.')}"</div>
      </div>
    `).join('');
  }

  function closeSourcePanel() {
    const panel = document.getElementById('source-panel');
    panel.classList.remove('panel-open');
    document.querySelectorAll('.citation-pill').forEach((p) => p.classList.remove('active'));
  }

  // Local Conversation Persistence
  function loadStoredConversations() {
    try {
      const stored = localStorage.getItem('veritas_conversations');
      state.conversations = stored ? JSON.parse(stored) : [];
      renderConversationList();
    } catch {
      state.conversations = [];
    }
  }

  function saveConversationToStorage(id, firstQuestion) {
    const existing = state.conversations.find((c) => c.id === id);
    if (!existing) {
      state.conversations.unshift({
        id,
        title: firstQuestion.slice(0, 40) + (firstQuestion.length > 40 ? '...' : ''),
        updatedAt: new Date().toISOString()
      });
      localStorage.setItem('veritas_conversations', JSON.stringify(state.conversations));
      renderConversationList();
    }
  }

  function renderConversationList() {
    const container = document.getElementById('conversations-list');
    if (!container) return;

    if (state.conversations.length === 0) {
      container.innerHTML = `<div style="padding:12px; font-size:12px; color:var(--ink-muted);">No saved conversations</div>`;
      return;
    }

    container.innerHTML = state.conversations.map((c) => `
      <div class="convo-item ${c.id === state.currentConversationId ? 'active' : ''}" data-convo-id="${c.id}">
        <span class="convo-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>
        <button type="button" class="convo-delete-btn" data-delete-convo="${c.id}" title="Remove conversation">✕</button>
      </div>
    `).join('');

    // Attach listeners
    container.querySelectorAll('.convo-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.convo-delete-btn')) {
          const deleteId = e.target.getAttribute('data-delete-convo');
          removeConversation(deleteId);
          return;
        }
        const convoId = item.getAttribute('data-convo-id');
        loadConversation(convoId);
      });
    });
  }

  async function loadConversation(id) {
    state.currentConversationId = id;
    renderConversationList();

    const container = document.getElementById('chat-messages');
    container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--ink-muted);">Loading conversation history...</div>`;

    try {
      const data = await api.getConversationMessages(id);
      container.innerHTML = '';
      if (!data.messages || data.messages.length === 0) {
        startNewConversation();
        return;
      }

      data.messages.forEach((msg) => {
        if (msg.role === 'user') {
          appendUserMessage(msg.content);
        } else {
          renderAssistantResponse({
            answer: msg.content,
            sources: [],
            status: 'answered'
          });
        }
      });
    } catch {
      container.innerHTML = `<div style="color:var(--brick); padding:20px;">Could not retrieve messages for this conversation.</div>`;
    }
  }

  function removeConversation(id) {
    state.conversations = state.conversations.filter((c) => c.id !== id);
    localStorage.setItem('veritas_conversations', JSON.stringify(state.conversations));
    if (state.currentConversationId === id) {
      startNewConversation();
    } else {
      renderConversationList();
    }
  }

  // --------------------------------------------------------------------------
  // SECTION 4: DOCUMENTS SCREEN & UPLOAD FLOW
  // --------------------------------------------------------------------------
  function initDocuments() {
    const dropZone = document.getElementById('drop-zone');
    const filePicker = document.getElementById('file-picker');
    const refreshBtn = document.getElementById('btn-refresh-docs');
    const searchInput = document.getElementById('docs-search');

    refreshBtn.addEventListener('click', () => loadDocuments());

    // Filter table
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      document.querySelectorAll('#documents-tbody tr').forEach((row) => {
        const title = row.getAttribute('data-title') || '';
        row.style.display = title.toLowerCase().includes(query) ? '' : 'none';
      });
    });

    // Drag and drop events
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleFileUpload(files[0]);
      }
    });

    filePicker.addEventListener('change', () => {
      if (filePicker.files && filePicker.files.length > 0) {
        handleFileUpload(filePicker.files[0]);
        filePicker.value = '';
      }
    });
  }

  async function handleFileUpload(file) {
    // 1. Client-side Validation
    const allowedExtensions = ['.pdf', '.docx', '.txt', '.md'];
    const extension = `.${file.name.split('.').pop().toLowerCase()}`;
    if (!allowedExtensions.includes(extension)) {
      showToast('Unsupported file type. Please upload PDF, DOCX, TXT, or MD.', 'error');
      return;
    }

    const maxBytes = 10 * 1024 * 1024; // 10MB
    if (file.size > maxBytes) {
      showToast('File exceeds the 10 MB limit.', 'error');
      return;
    }

    // UI Progress Display
    const progressContainer = document.getElementById('upload-progress-container');
    const filenameLabel = document.getElementById('upload-filename');
    const statusText = document.getElementById('upload-status-text');
    const fill = document.getElementById('upload-progress-fill');

    progressContainer.style.display = 'block';
    filenameLabel.textContent = file.name;
    statusText.textContent = 'Requesting presigned URL...';
    fill.style.width = '15%';

    try {
      // Step 2: Request presigned S3 URL
      const { document_id, upload_url } = await api.createUploadUrl(file.name);

      // Step 3: Direct S3 PUT Upload
      statusText.textContent = 'Uploading directly to S3...';
      await api.uploadToS3(upload_url, file, (percent) => {
        fill.style.width = `${15 + Math.round(percent * 0.55)}%`;
      });

      // Step 4: Initiate Backend Ingestion
      statusText.textContent = 'Ingesting and vectorizing document...';
      fill.style.width = '85%';
      await api.completeUpload(document_id);

      fill.style.width = '100%';
      statusText.textContent = 'Ingestion complete!';
      showToast(`Document "${file.name}" uploaded successfully`, 'success');

      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 2500);

      // Refresh list and start polling
      loadDocuments();
    } catch (err) {
      statusText.textContent = 'Upload failed';
      fill.style.backgroundColor = 'var(--brick)';
      showToast(err.message || 'Document upload failed', 'error');
      setTimeout(() => {
        progressContainer.style.display = 'none';
        fill.style.backgroundColor = 'var(--verdigris)';
      }, 4000);
    }
  }

  async function loadDocuments() {
    try {
      const data = await api.getDocuments();
      state.documents = data.documents || [];
      renderDocumentsTable(state.documents);
      checkDocumentPolling();
    } catch {
      showToast('Could not load workspace documents', 'error');
    }
  }

  function renderDocumentsTable(docs) {
    const tbody = document.getElementById('documents-tbody');
    const emptyState = document.getElementById('docs-empty-state');
    const countPill = document.getElementById('docs-count');

    countPill.textContent = docs.length;

    if (docs.length === 0) {
      tbody.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';
    tbody.innerHTML = docs.map((doc) => {
      const ext = doc.title.split('.').pop().toUpperCase();
      let statusClass = 'status-ready';
      let statusText = 'Ready';

      if (doc.status === 'pending' || doc.status === 'processing') {
        statusClass = 'status-pending';
        statusText = doc.status === 'processing' ? 'Processing' : 'Pending';
      } else if (doc.status === 'failed') {
        statusClass = 'status-failed';
        statusText = 'Failed';
      }

      return `
        <tr data-title="${escapeHtml(doc.title)}">
          <td>
            <div class="doc-title-cell">
              <span class="doc-format-tag">${escapeHtml(ext)}</span>
              <strong>${escapeHtml(doc.title)}</strong>
            </div>
          </td>
          <td>
            <span class="status-pill ${statusClass}">
              <span class="dot"></span>
              <span>${statusText}</span>
            </span>
          </td>
          <td>v${doc.current_version || 1}</td>
          <td>${formatDate(doc.created_at)}</td>
          <td class="text-right">
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.VeritasApp.requestDocumentDeletion('${escapeHtml(doc.title)}')">
              Request deletion
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function checkDocumentPolling() {
    const hasUnfinished = state.documents.some(
      (d) => d.status === 'pending' || d.status === 'processing'
    );

    if (hasUnfinished && !state.pollingInterval) {
      state.pollingInterval = setInterval(async () => {
        const data = await api.getDocuments().catch(() => ({ documents: [] }));
        state.documents = data.documents || [];
        renderDocumentsTable(state.documents);

        const stillPending = state.documents.some(
          (d) => d.status === 'pending' || d.status === 'processing'
        );
        if (!stillPending) {
          clearInterval(state.pollingInterval);
          state.pollingInterval = null;
        }
      }, 3000);
    } else if (!hasUnfinished && state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
  }

  // --------------------------------------------------------------------------
  // SECTION 5: APPROVALS SCREEN (HUMAN IN THE LOOP)
  // --------------------------------------------------------------------------
  function initApprovals() {
    const refreshBtn = document.getElementById('btn-refresh-approvals');
    refreshBtn.addEventListener('click', () => loadApprovals());

    document.querySelectorAll('.sub-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const subtab = tab.getAttribute('data-subtab');
        document.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');

        document.querySelectorAll('.subtab-content').forEach((c) => c.classList.remove('active'));
        const activeContent = document.getElementById(`approvals-${subtab}-view`);
        if (activeContent) activeContent.classList.add('active');
      });
    });
  }

  async function loadApprovals() {
    try {
      const data = await api.getApprovals();
      const all = data.approvals || [];
      const pending = all.filter((a) => a.status === 'pending');
      const history = all.filter((a) => a.status !== 'pending');

      // Update badge counts
      const countEl = document.getElementById('pending-approvals-count');
      const subtabCountEl = document.getElementById('subtab-pending-count');
      if (countEl) {
        countEl.textContent = pending.length;
        countEl.style.display = pending.length > 0 ? 'inline-flex' : 'none';
      }
      if (subtabCountEl) {
        subtabCountEl.textContent = pending.length;
      }

      renderPendingApprovals(pending);
      renderApprovalHistory(history);
    } catch (err) {
      showToast(err.message || 'Could not load approvals queue', 'error');
    }
  }

  function renderPendingApprovals(pendingList) {
    const container = document.getElementById('approvals-pending-list');
    const empty = document.getElementById('approvals-pending-empty');

    if (pendingList.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    container.innerHTML = pendingList.map((appr) => `
      <div class="approval-card pending-border">
        <div>
          <div class="approval-card-top">
            <span class="approval-req-id">ID: ${escapeHtml(appr.id.slice(0, 8))}...</span>
            <span class="status-pill status-pending"><span class="dot"></span>Waiting for Review</span>
          </div>
          <div class="approval-question">"${escapeHtml(appr.question)}"</div>
          <div class="approval-meta">
            <span>Requested by: <strong>${escapeHtml(appr.requester)}</strong></span>
            <span>Requested at: ${formatDate(appr.created_at)}</span>
          </div>
        </div>
        <div class="approval-actions">
          <button type="button" class="btn btn-approve btn-sm" onclick="window.VeritasApp.handleApprovalDecision('${appr.id}', true)">
            Approve action
          </button>
          <button type="button" class="btn btn-reject btn-sm" onclick="window.VeritasApp.handleApprovalDecision('${appr.id}', false)">
            Reject
          </button>
        </div>
      </div>
    `).join('');
  }

  function renderApprovalHistory(historyList) {
    const container = document.getElementById('approvals-history-list');
    const empty = document.getElementById('approvals-history-empty');

    if (historyList.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    container.innerHTML = historyList.map((appr) => {
      const isApproved = appr.status === 'approved';
      return `
        <div class="approval-card ${isApproved ? 'approved-border' : 'rejected-border'}">
          <div>
            <div class="approval-card-top">
              <span class="approval-req-id">ID: ${escapeHtml(appr.id.slice(0, 8))}...</span>
              <span class="status-pill ${isApproved ? 'status-ready' : 'status-failed'}">
                <span class="dot"></span>
                <span>${isApproved ? 'Approved' : 'Rejected'}</span>
              </span>
            </div>
            <div class="approval-question">"${escapeHtml(appr.question)}"</div>
            <div class="approval-meta">
              <span>Requester: ${escapeHtml(appr.requester)}</span>
              <span>Reviewer: ${escapeHtml(appr.reviewer || 'System')}</span>
              <span>Decided at: ${formatDate(appr.reviewed_at)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async function handleApprovalDecision(approvalId, approve) {
    const verb = approve ? 'approve' : 'reject';
    openConfirmModal(
      `Confirm Decision`,
      `Are you sure you want to ${verb} this requested operation?`,
      async () => {
        try {
          await api.decideApproval(approvalId, approve);
          showToast(`Approval request ${approve ? 'approved' : 'rejected'}`, 'success');
          loadApprovals();
        } catch (err) {
          showToast(err.message || 'Failed to record decision', 'error');
        }
      }
    );
  }

  // --------------------------------------------------------------------------
  // SECTION 6: ADMIN DASHBOARD SCREEN
  // --------------------------------------------------------------------------
  function initAdmin() {
    const refreshBtn = document.getElementById('btn-refresh-admin');
    refreshBtn.addEventListener('click', () => loadAdminDashboard());
  }

  async function loadAdminDashboard() {
    try {
      const [metricsData, guardrailData] = await Promise.all([
        api.getAdminMetrics().catch(() => ({ documents: [], feedback: [] })),
        api.getAdminGuardrails().catch(() => ({ events: [], mode: 'deterministic_demo' }))
      ]);

      // 1. Documents Metrics
      const docs = metricsData.documents || [];
      let totalDocs = 0;
      let readyCount = 0;
      let pendingCount = 0;
      let failedCount = 0;

      docs.forEach((d) => {
        totalDocs += d.total;
        if (d.status === 'ready') readyCount += d.total;
        else if (d.status === 'pending' || d.status === 'processing') pendingCount += d.total;
        else if (d.status === 'failed') failedCount += d.total;
      });

      document.getElementById('metric-docs-total').textContent = totalDocs;
      document.getElementById('metric-docs-breakdown').innerHTML = `
        <span class="stat-pill stat-ready">${readyCount} ready</span>
        <span class="stat-pill stat-pending">${pendingCount} processing</span>
        <span class="stat-pill stat-failed">${failedCount} failed</span>
      `;

      // 2. Feedback Metrics
      const feedback = metricsData.feedback || [];
      let totalFb = 0;
      let helpful = 0;
      let unhelpful = 0;

      feedback.forEach((f) => {
        totalFb += f.total;
        if (f.rating === 1) helpful += f.total;
        else if (f.rating === -1) unhelpful += f.total;
      });

      document.getElementById('metric-feedback-total').textContent = totalFb;
      document.getElementById('metric-feedback-breakdown').innerHTML = `
        <span class="stat-pill stat-positive">👍 ${helpful} helpful</span>
        <span class="stat-pill stat-negative">👎 ${unhelpful} unhelpful</span>
      `;

      // 3. Guardrail Metrics
      const events = guardrailData.events || [];
      let totalBlocks = 0;
      let inputBlocks = 0;
      let outputBlocks = 0;

      events.forEach((ev) => {
        totalBlocks += ev.total;
        if (ev.action === 'guardrail_input_blocked') inputBlocks += ev.total;
        else if (ev.action === 'guardrail_output_blocked') outputBlocks += ev.total;
      });

      document.getElementById('metric-guardrail-total').textContent = totalBlocks;
      document.getElementById('metric-guardrail-breakdown').innerHTML = `
        <span class="stat-pill stat-input">${inputBlocks} input injections</span>
        <span class="stat-pill stat-output">${outputBlocks} output leaks</span>
      `;

      if (guardrailData.mode) {
        document.getElementById('config-guardrail-mode').textContent = guardrailData.mode;
      }
    } catch {
      showToast('Could not refresh admin metrics', 'error');
    }
  }

  // --------------------------------------------------------------------------
  // SECTION 7: MODAL DIALOGS
  // --------------------------------------------------------------------------
  function openFeedbackModal(rating) {
    state.pendingFeedbackRating = rating;
    const modal = document.getElementById('feedback-modal');
    const iconPreview = document.getElementById('feedback-icon-preview');
    const ratingLabel = document.getElementById('feedback-rating-label');
    const noteInput = document.getElementById('feedback-note');

    iconPreview.textContent = rating === 1 ? '👍' : '👎';
    ratingLabel.textContent = rating === 1 ? 'Helpful answer' : 'Unhelpful answer';
    noteInput.value = '';

    modal.style.display = 'flex';
    noteInput.focus();
  }

  function closeFeedbackModal() {
    document.getElementById('feedback-modal').style.display = 'none';
  }

  function initModals() {
    // Feedback modal
    const feedbackModal = document.getElementById('feedback-modal');
    const closeFeedbackBtn = document.getElementById('close-feedback-modal');
    const cancelFeedbackBtn = document.getElementById('btn-cancel-feedback');
    const feedbackForm = document.getElementById('feedback-form');

    closeFeedbackBtn.addEventListener('click', closeFeedbackModal);
    cancelFeedbackBtn.addEventListener('click', closeFeedbackModal);

    feedbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = document.getElementById('feedback-note').value.trim();
      try {
        await api.submitFeedback(null, state.pendingFeedbackRating, note);
        closeFeedbackModal();
        showToast('Thank you for your feedback!', 'success');
      } catch {
        showToast('Could not save feedback', 'error');
      }
    });

    // Confirm modal
    const confirmModal = document.getElementById('confirm-modal');
    const closeConfirmBtn = document.getElementById('close-confirm-modal');
    const cancelConfirmBtn = document.getElementById('btn-confirm-cancel');

    closeConfirmBtn.addEventListener('click', () => confirmModal.style.display = 'none');
    cancelConfirmBtn.addEventListener('click', () => confirmModal.style.display = 'none');
  }

  let onConfirmCallback = null;

  function openConfirmModal(title, message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    onConfirmCallback = onConfirm;

    const okBtn = document.getElementById('btn-confirm-ok');
    okBtn.onclick = () => {
      modal.style.display = 'none';
      if (onConfirmCallback) onConfirmCallback();
    };

    modal.style.display = 'flex';
  }

  // Deletion approval trigger helper
  function requestDocumentDeletion(title) {
    openConfirmModal(
      'Request Document Deletion',
      `Deleting "${title}" is a sensitive action. In Veritas, document deletion is held for human-in-the-loop approval. Do you want to submit this request?`,
      async () => {
        try {
          switchView('chat');
          const input = document.getElementById('chat-input');
          input.value = `Delete document: ${title}`;
          document.getElementById('chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
        } catch {
          showToast('Could not submit deletion approval request', 'error');
        }
      }
    );
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION ENTRYPOINT
  // --------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initShell();
    initChat();
    initDocuments();
    initApprovals();
    initAdmin();
    initModals();

    // Check approvals count on startup
    api.getApprovals().then((data) => {
      const pending = (data.approvals || []).filter((a) => a.status === 'pending');
      const badge = document.getElementById('pending-approvals-count');
      if (badge && pending.length > 0) {
        badge.textContent = pending.length;
        badge.style.display = 'inline-flex';
      }
    }).catch(() => {});
  });

  // Global namespace for inline action handlers
  window.VeritasApp = {
    switchView,
    handleApprovalDecision,
    requestDocumentDeletion
  };
})();
