/**
 * Puter AI Reactive Chat Application
 * Features:
 * - ChatGPT-Style Multi-Chat Sessions with Puter KV Cloud Persistence
 * - DeepSeek V4.1 Flash 1017 (Default) & GPT-6.1 Sol
 * - Full Reasoning Effort Controls (Low, Medium, High, Max, None)
 * - Multimodal Image Vision (Base64 file picker + paste support)
 * - Cloud Persisted System Instructions via Puter KV Store
 * - Puter Serverless Authentication & Anonymous Session Onboarding
 */

const KV_SYSTEM_INSTRUCTION_KEY = 'puter_system_instruction_v1';
const KV_CHAT_SESSIONS_KEY = 'puter_chat_sessions_v1';
const MAX_SAVED_SESSIONS = 30;

const DEFAULT_SYSTEM_INSTRUCTION =
  'You are a senior software engineer and pragmatic AI assistant. Provide direct, high-quality, production-ready responses. Skip unnecessary filler and directly address technical questions with clean code and clear trade-off explanations.';

const PRESETS = {
  architect:
    'You are a Pragmatic Senior Software Architect. Skip introductory fluff, prioritize clean design patterns, call out architectural trade-offs immediately, and provide production-ready code with explicit comments.',
  concise:
    'You are an ultra-concise assistant. Answer in 2-4 sentences or compact bullet points. Skip polite pleasantries and deliver only direct facts and solutions.',
  socratic:
    'You are a Socratic engineering mentor. Do not immediately give the final answer. Ask guided questions and provide targeted hints to help the user derive the solution from first principles.',
  reset: DEFAULT_SYSTEM_INSTRUCTION,
};

// Application State
let activeSystemPrompt = DEFAULT_SYSTEM_INSTRUCTION;
let conversationHistory = []; // Multi-turn payload for Puter AI in active session
let currentAttachment = null; // { name: string, dataUrl: string }
let sessions = []; // Array of saved chat sessions
let activeSessionId = null; // ID of the currently loaded session

// DOM Elements - Sidebar & Sessions
const chatSidebar = document.getElementById('chat-sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const sessionsList = document.getElementById('sessions-list');
const clearAllSessionsBtn = document.getElementById('clear-all-sessions-btn');

// DOM Elements - Header & Controls
const modelSelect = document.getElementById('model-select');
const reasoningSelect = document.getElementById('reasoning-select');
const cloudStatus = document.getElementById('cloud-status');
const systemPromptBtn = document.getElementById('system-prompt-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const authBox = document.getElementById('auth-box');
const userDisplay = document.getElementById('user-display');
const signInBtn = document.getElementById('sign-in-btn');
const signOutBtn = document.getElementById('sign-out-btn');

// DOM Elements - Viewport & Feed
const chatViewport = document.getElementById('chat-viewport');
const welcomeScreen = document.getElementById('welcome-screen');
const messagesList = document.getElementById('messages-list');
const quickCards = document.querySelectorAll('.quick-card');

// DOM Elements - Bottom Dock
const chatForm = document.getElementById('chat-form');
const chatTextarea = document.getElementById('chat-textarea');
const uploadBtn = document.getElementById('upload-btn');
const imageInput = document.getElementById('image-input');
const sendBtn = document.getElementById('send-btn');
const attachmentPreview = document.getElementById('attachment-preview');
const previewImg = document.getElementById('preview-img');
const previewName = document.getElementById('preview-name');
const removeImgBtn = document.getElementById('remove-img-btn');

// DOM Elements - System Modal
const systemModal = document.getElementById('system-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelPromptBtn = document.getElementById('cancel-prompt-btn');
const savePromptBtn = document.getElementById('save-prompt-btn');
const systemPromptInput = document.getElementById('system-prompt-input');
const saveStatus = document.getElementById('save-status');
const presetPills = document.querySelectorAll('.preset-pill');

/**
 * ==========================================
 * 1. Puter Cloud KV: Chat Sessions Management
 * ==========================================
 */

async function loadSessionsFromKV() {
  try {
    let raw = null;
    if (typeof puter !== 'undefined' && puter.kv) {
      raw = await puter.kv.get(KV_CHAT_SESSIONS_KEY);
    }

    if (!raw) {
      raw = localStorage.getItem(KV_CHAT_SESSIONS_KEY);
    }

    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        sessions = parsed;
      }
    }
  } catch (err) {
    console.warn('Failed to load chat sessions from Puter KV:', err);
    const local = localStorage.getItem(KV_CHAT_SESSIONS_KEY);
    sessions = local ? JSON.parse(local) : [];
  } finally {
    renderSessionsList();
  }
}

/**
 * Persist sessions to Puter KV store
 * Sanitizes heavy Base64 image strings to stay strictly well below Puter's 400KB per-key limit.
 */
async function saveSessionsToKV() {
  // Deep clone and sanitize to prevent 400KB KV limit overflow
  const cleanSessions = sessions.slice(0, MAX_SAVED_SESSIONS).map((s) => ({
    id: s.id,
    title: s.title,
    model: s.model,
    reasoningEffort: s.reasoningEffort,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: (s.messages || []).map((m) => {
      // If user message contained an image array, preserve text and flag, but strip large base64
      if (Array.isArray(m.content)) {
        const textPart = m.content.find((p) => p.type === 'text')?.text || '';
        return {
          role: m.role,
          content: textPart,
          hasImage: true,
        };
      }
      return {
        role: m.role,
        content: m.content,
        hasImage: !!m.hasImage,
      };
    }),
  }));

  // Save to local storage immediately
  localStorage.setItem(KV_CHAT_SESSIONS_KEY, JSON.stringify(cleanSessions));

  // Sync to Puter KV Database
  if (typeof puter !== 'undefined' && puter.kv) {
    try {
      await puter.kv.set(KV_CHAT_SESSIONS_KEY, cleanSessions);
    } catch (err) {
      console.error('Failed to sync sessions to Puter KV:', err);
    }
  }

  renderSessionsList();
}

function renderSessionsList() {
  sessionsList.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-sessions';
    empty.textContent = 'No past conversations yet.';
    sessionsList.appendChild(empty);
    return;
  }

  sessions.forEach((s) => {
    const item = document.createElement('div');
    item.className = `session-item ${s.id === activeSessionId ? 'active' : ''}`;
    item.dataset.id = s.id;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-title';
    titleSpan.textContent = s.title || 'Untitled Chat';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-session-btn';
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete chat';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });

    item.appendChild(titleSpan);
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => {
      loadSession(s.id);
    });

    sessionsList.appendChild(item);
  });
}

function createNewSession(firstPrompt = '') {
  const newId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const cleanTitle = firstPrompt
    ? firstPrompt.slice(0, 36) + (firstPrompt.length > 36 ? '...' : '')
    : 'New Chat';

  const newSession = {
    id: newId,
    title: cleanTitle,
    model: modelSelect.value || 'deepseek/deepseek-v4.1-flash-1017',
    reasoningEffort: reasoningSelect.value || 'high',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };

  sessions.unshift(newSession);
  activeSessionId = newId;
  return newSession;
}

function loadSession(id) {
  const session = sessions.find((s) => s.id === id);
  if (!session) return;

  activeSessionId = id;

  // Restore model and reasoning settings
  if (session.model) modelSelect.value = session.model;
  if (session.reasoningEffort) reasoningSelect.value = session.reasoningEffort;

  // Reset viewport and hide welcome screen
  messagesList.innerHTML = '';
  welcomeScreen.style.display = 'none';
  clearAttachment();

  // Re-build multi-turn conversationHistory and render messages
  conversationHistory = [];
  (session.messages || []).forEach((m) => {
    conversationHistory.push({
      role: m.role,
      content: m.content,
    });
    appendMessageUI(m.role, m.content, null, m.hasImage);
  });

  renderSessionsList();

  // Close sidebar on small screens
  if (window.innerWidth <= 768) {
    chatSidebar.classList.add('collapsed');
  }

  chatTextarea.focus();
}

async function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);

  if (activeSessionId === id) {
    resetConversation();
  }

  await saveSessionsToKV();
}

async function clearAllSessions() {
  if (!confirm('Are you sure you want to delete all chat history?')) return;
  sessions = [];
  await saveSessionsToKV();
  resetConversation();
}

/**
 * ==========================================
 * 2. Puter Cloud KV: System Instructions
 * ==========================================
 */

async function loadSystemInstructions() {
  try {
    if (typeof puter !== 'undefined' && puter.kv) {
      const stored = await puter.kv.get(KV_SYSTEM_INSTRUCTION_KEY);
      if (stored && typeof stored === 'string' && stored.trim().length > 0) {
        activeSystemPrompt = stored;
      } else {
        activeSystemPrompt = DEFAULT_SYSTEM_INSTRUCTION;
      }
    } else {
      activeSystemPrompt = localStorage.getItem(KV_SYSTEM_INSTRUCTION_KEY) || DEFAULT_SYSTEM_INSTRUCTION;
    }
  } catch (err) {
    console.warn('Could not read system instructions from Puter KV:', err);
    activeSystemPrompt = localStorage.getItem(KV_SYSTEM_INSTRUCTION_KEY) || DEFAULT_SYSTEM_INSTRUCTION;
  }
}

async function saveSystemInstructions(newPrompt) {
  activeSystemPrompt = newPrompt.trim() || DEFAULT_SYSTEM_INSTRUCTION;
  localStorage.setItem(KV_SYSTEM_INSTRUCTION_KEY, activeSystemPrompt);

  if (typeof puter !== 'undefined' && puter.kv) {
    saveStatus.textContent = 'Saving to Puter DB...';
    try {
      await puter.kv.set(KV_SYSTEM_INSTRUCTION_KEY, activeSystemPrompt);
      saveStatus.textContent = 'Saved to Puter DB ✓';
      setTimeout(() => {
        saveStatus.textContent = '';
      }, 2000);
    } catch (err) {
      console.error('Failed to save to Puter KV:', err);
      saveStatus.textContent = 'Saved locally (Puter offline)';
    }
  } else {
    saveStatus.textContent = 'Saved locally ✓';
  }
}

/**
 * ==========================================
 * 3. Puter Auth & Session Onboarding
 * ==========================================
 */

async function updateAuthStatus() {
  if (typeof puter === 'undefined' || !puter.auth) {
    cloudStatus.textContent = 'SDK Offline';
    cloudStatus.classList.add('offline');
    return;
  }

  const isSignedIn = puter.auth.isSignedIn();
  if (isSignedIn) {
    try {
      const user = await puter.auth.getUser();
      userDisplay.textContent = user?.username ? `@${user.username}` : 'Puter User';
      userDisplay.style.display = 'inline';
      signOutBtn.style.display = 'inline-block';
      signInBtn.style.display = 'none';
      cloudStatus.textContent = 'Cloud Connected';
      cloudStatus.classList.remove('offline');
    } catch {
      showGuestAuth();
    }
  } else {
    showGuestAuth();
  }
}

function showGuestAuth() {
  userDisplay.textContent = 'Guest Session';
  userDisplay.style.display = 'inline';
  signOutBtn.style.display = 'none';
  signInBtn.style.display = 'inline-block';
  cloudStatus.textContent = 'Temp Session';
}

/**
 * ==========================================
 * 4. Image Modality (Vision) Processing
 * ==========================================
 */

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDimension = 1280;
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleImageSelect(file) {
  if (!file || !file.type.startsWith('image/')) return;

  try {
    const dataUrl = await processImageFile(file);
    currentAttachment = {
      name: file.name,
      dataUrl: dataUrl,
    };

    previewImg.src = dataUrl;
    previewName.textContent = file.name;
    attachmentPreview.style.display = 'flex';
    chatTextarea.focus();
  } catch (err) {
    console.error('Failed to process image:', err);
    alert('Unable to load image. Please try another file.');
  }
}

function clearAttachment() {
  currentAttachment = null;
  imageInput.value = '';
  attachmentPreview.style.display = 'none';
  previewImg.src = '';
}

/**
 * ==========================================
 * 5. Chat Execution & Puter AI API
 * ==========================================
 */

async function sendMessage(text) {
  const promptText = text.trim();
  if (!promptText && !currentAttachment) return;

  // Initialize or fetch active session
  let currentSession = sessions.find((s) => s.id === activeSessionId);
  if (!currentSession) {
    currentSession = createNewSession(promptText || 'Image Query');
  }

  // Hide welcome screen
  welcomeScreen.style.display = 'none';

  // Snapshot current attachment if present
  const attachmentSnapshot = currentAttachment;
  clearAttachment();

  // Reset textarea
  chatTextarea.value = '';
  chatTextarea.style.height = 'auto';
  chatTextarea.disabled = true;
  sendBtn.disabled = true;
  uploadBtn.disabled = true;

  // Append User message to UI
  appendMessageUI('user', promptText, attachmentSnapshot?.dataUrl);

  // Prepare Payload for Puter AI
  let userContent;
  if (attachmentSnapshot) {
    userContent = [
      { type: 'text', text: promptText || 'Analyze this image.' },
      { type: 'image_url', image_url: { url: attachmentSnapshot.dataUrl } },
    ];
  } else {
    userContent = promptText;
  }

  // Push to local conversation history and active session
  conversationHistory.push({
    role: 'user',
    content: userContent,
  });

  currentSession.messages.push({
    role: 'user',
    content: promptText,
    hasImage: !!attachmentSnapshot,
  });
  currentSession.updatedAt = Date.now();

  const selectedModel = modelSelect.value || 'deepseek/deepseek-v4.1-flash-1017';
  const reasoningEffort = reasoningSelect.value || 'high';

  currentSession.model = selectedModel;
  currentSession.reasoningEffort = reasoningEffort;

  // Show thinking UI
  const thinkingElem = appendThinkingUI(selectedModel, reasoningEffort);

  try {
    if (typeof puter === 'undefined' || !puter.ai) {
      throw new Error('Puter AI SDK is not available.');
    }

    const messagesPayload = [
      { role: 'system', content: activeSystemPrompt },
      ...conversationHistory.slice(-8),
    ];

    const options = {
      model: selectedModel,
    };

    if (reasoningEffort !== 'none') {
      options.reasoning_effort = reasoningEffort;
    }

    // Call Puter.js AI
    const response = await puter.ai.chat(messagesPayload, options);

    const replyText =
      typeof response === 'string'
        ? response
        : response?.message?.content || response?.text || JSON.stringify(response);

    // Remove thinking indicator
    thinkingElem.remove();

    // Push to conversation history and session
    conversationHistory.push({
      role: 'assistant',
      content: replyText,
    });

    currentSession.messages.push({
      role: 'assistant',
      content: replyText,
    });
    currentSession.updatedAt = Date.now();

    appendMessageUI('assistant', replyText);

    // Persist updated session thread to Puter KV Store
    await saveSessionsToKV();
  } catch (err) {
    console.error('Puter AI call failed:', err);
    thinkingElem.remove();
    appendMessageUI(
      'assistant',
      `⚠️ Error communicating with ${selectedModel}: ${err.message || 'Request failed. Please verify your connection or Puter sign-in.'}`
    );
  } finally {
    chatTextarea.disabled = false;
    sendBtn.disabled = false;
    uploadBtn.disabled = false;
    chatTextarea.focus();
    scrollToBottom();
  }
}

/**
 * ==========================================
 * 4. Markdown Formatter & Code Copy Engine
 * ==========================================
 */

/**
 * Robust, XSS-safe Markdown to HTML converter
 * Supports bold, italics, headers, code blocks with copy button, inline code, and lists.
 * @param {string} text
 * @returns {string} Sanitized HTML
 */
function formatMarkdown(text) {
  if (!text) return '';

  // 1. Extract and store Code Blocks (```lang ... ```) so code contents are never altered
  const codeBlocks = [];
  let processed = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__MD_CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: (lang || 'text').toLowerCase(), code: code.trim() });
    return placeholder;
  });

  // 2. Escape HTML entities on remaining text to ensure complete XSS safety
  processed = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 3. Headers (# ## ###)
  processed = processed.replace(/^### (.*$)/gim, '<h3 class="md-h3">$1</h3>');
  processed = processed.replace(/^## (.*$)/gim, '<h2 class="md-h2">$1</h2>');
  processed = processed.replace(/^# (.*$)/gim, '<h1 class="md-h1">$1</h1>');

  // 4. Bold and Italic formatting (***bold italic***, **bold**, *italic*)
  processed = processed.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  processed = processed.replace(/\*(.*?)\*/g, '<em>$1</em>');

  // 5. Inline Code (`code`)
  processed = processed.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // 6. Horizontal Rules (---)
  processed = processed.replace(/^---$/gim, '<hr class="md-hr" />');

  // 7. Parse line-by-line for ordered lists, unordered lists, and clean paragraphs
  const lines = processed.split('\n');
  const formattedLines = [];

  lines.forEach((line) => {
    const trimmed = line.trim();

    // Ordered list: "1. Item"
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      formattedLines.push(
        `<div class="md-list-item"><span class="md-list-num">${orderedMatch[1]}.</span><div class="md-list-body">${orderedMatch[2]}</div></div>`
      );
      return;
    }

    // Unordered bullet list: "- Item" or "* Item" or "• Item"
    const unorderedMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (unorderedMatch) {
      formattedLines.push(
        `<div class="md-list-item"><span class="md-list-bullet">•</span><div class="md-list-body">${unorderedMatch[1]}</div></div>`
      );
      return;
    }

    // Empty line produces clean structural spacing
    if (!trimmed) {
      formattedLines.push('<div class="md-gap"></div>');
      return;
    }

    // Regular paragraph text
    formattedLines.push(`<p class="md-para">${line}</p>`);
  });

  let html = formattedLines.join('');

  // 8. Re-insert Code Blocks with Language Header and Copy Button
  codeBlocks.forEach((block, index) => {
    const placeholder = `__MD_CODE_BLOCK_${index}__`;
    const escapedCode = block.code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const codeHtml = `
      <div class="code-box">
        <div class="code-box-header">
          <span class="code-box-lang">${block.lang}</span>
          <button type="button" class="code-copy-btn" onclick="copyCode(this)">Copy</button>
        </div>
        <pre><code class="code-box-pre">${escapedCode}</code></pre>
      </div>
    `;

    html = html.replace(placeholder, codeHtml);
  });

  return html;
}

/**
 * Global helper to copy code block content to clipboard
 */
window.copyCode = function(button) {
  const codeBox = button.closest('.code-box');
  const codeElem = codeBox?.querySelector('code');
  if (codeElem) {
    navigator.clipboard.writeText(codeElem.innerText).then(() => {
      button.textContent = 'Copied! ✓';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 2000);
    });
  }
};

/**
 * Append message row to chat feed
 */
function appendMessageUI(role, text, imageSrc = null, hasImagePlaceholder = false) {
  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = `avatar ${role === 'user' ? 'user-avatar' : 'ai-avatar'}`;
  avatar.textContent = role === 'user' ? 'You' : 'AI';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (imageSrc) {
    const img = document.createElement('img');
    img.src = imageSrc;
    img.className = 'message-image-thumb';
    img.alt = 'Uploaded Image';
    img.addEventListener('click', () => {
      window.open(imageSrc, '_blank');
    });
    contentDiv.appendChild(img);
  } else if (hasImagePlaceholder) {
    const badge = document.createElement('div');
    badge.className = 'thinking-badge';
    badge.textContent = '📷 [Attached Image]';
    contentDiv.appendChild(badge);
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  // Assistant messages get full rich markdown formatting; User messages get escaped text
  if (role === 'assistant') {
    bubble.innerHTML = formatMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  contentDiv.appendChild(bubble);
  row.appendChild(avatar);
  row.appendChild(contentDiv);

  messagesList.appendChild(row);
  scrollToBottom();
  return row;
}

function appendThinkingUI(modelName, effort) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';

  const avatar = document.createElement('div');
  avatar.className = 'avatar ai-avatar';
  avatar.textContent = 'AI';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  const badge = document.createElement('div');
  badge.className = 'thinking-badge';
  const shortModel = modelName.includes('deepseek') ? 'DeepSeek V4.1' : 'GPT-6.1 Sol';
  badge.innerHTML = `Thinking with <strong>${shortModel}</strong> (Effort: <em>${effort}</em>)...`;

  contentDiv.appendChild(badge);
  row.appendChild(avatar);
  row.appendChild(contentDiv);

  messagesList.appendChild(row);
  scrollToBottom();
  return row;
}

function scrollToBottom() {
  chatViewport.scrollTop = chatViewport.scrollHeight;
}

function resetConversation() {
  activeSessionId = null;
  conversationHistory = [];
  messagesList.innerHTML = '';
  welcomeScreen.style.display = 'flex';
  clearAttachment();
  chatTextarea.value = '';
  renderSessionsList();
  chatTextarea.focus();
}

/**
 * ==========================================
 * 6. Event Listeners & Bootstrapping
 * ==========================================
 */

function setupEventListeners() {
  // Sidebar Toggle
  sidebarToggleBtn.addEventListener('click', () => {
    chatSidebar.classList.toggle('collapsed');
  });

  // New Chat Button in Sidebar & Header
  newChatBtn.addEventListener('click', resetConversation);
  clearChatBtn.addEventListener('click', resetConversation);

  // Clear All Sessions
  clearAllSessionsBtn.addEventListener('click', clearAllSessions);

  // Auto-expanding textarea
  chatTextarea.addEventListener('input', () => {
    chatTextarea.style.height = 'auto';
    chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 200) + 'px';
  });

  // Enter to send, Shift+Enter for new line
  chatTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(chatTextarea.value);
    }
  });

  // Form submit
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(chatTextarea.value);
  });

  // Image Upload Button
  uploadBtn.addEventListener('click', () => {
    imageInput.click();
  });

  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImageSelect(file);
  });

  // Paste image directly into textarea
  chatTextarea.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          handleImageSelect(file);
          e.preventDefault();
          break;
        }
      }
    }
  });

  removeImgBtn.addEventListener('click', clearAttachment);

  // Quick Prompt Cards
  quickCards.forEach((card) => {
    card.addEventListener('click', () => {
      const prompt = card.dataset.prompt;
      if (prompt) sendMessage(prompt);
    });
  });

  // System Prompt Modal
  systemPromptBtn.addEventListener('click', () => {
    systemPromptInput.value = activeSystemPrompt;
    saveStatus.textContent = '';
    systemModal.style.display = 'flex';
    systemPromptInput.focus();
  });

  closeModalBtn.addEventListener('click', () => {
    systemModal.style.display = 'none';
  });

  cancelPromptBtn.addEventListener('click', () => {
    systemModal.style.display = 'none';
  });

  savePromptBtn.addEventListener('click', async () => {
    await saveSystemInstructions(systemPromptInput.value);
    setTimeout(() => {
      systemModal.style.display = 'none';
    }, 600);
  });

  // Prompt Preset Pills
  presetPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const key = pill.dataset.preset;
      if (PRESETS[key]) {
        systemPromptInput.value = PRESETS[key];
      }
    });
  });

  // Puter Auth Handlers
  signInBtn.addEventListener('click', async () => {
    try {
      await puter.auth.signIn();
      await updateAuthStatus();
      await loadSystemInstructions();
      await loadSessionsFromKV();
    } catch (err) {
      console.warn('Sign-in cancelled or failed:', err);
    }
  });

  signOutBtn.addEventListener('click', async () => {
    try {
      puter.auth.signOut();
      await updateAuthStatus();
      await puter.auth.signIn({ attempt_temp_user_creation: true }).catch(() => null);
      await loadSystemInstructions();
      await loadSessionsFromKV();
    } catch (err) {
      console.error('Sign-out error:', err);
    }
  });
}

/**
 * App Initializer
 */
async function initApp() {
  setupEventListeners();

  if (typeof puter !== 'undefined' && puter.auth) {
    try {
      if (!puter.auth.isSignedIn()) {
        await puter.auth.signIn({ attempt_temp_user_creation: true }).catch(() => null);
      }
      await updateAuthStatus();
      await loadSystemInstructions();
      await loadSessionsFromKV();
    } catch (err) {
      console.error('Initialization error:', err);
      cloudStatus.textContent = 'Init Fallback';
      loadSessionsFromKV();
    }
  } else {
    cloudStatus.textContent = 'Puter Unavailable';
    cloudStatus.classList.add('offline');
    loadSessionsFromKV();
  }
}

// Start on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
