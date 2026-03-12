// ── Agent Chat ──

async function sendAgentMessage() {
    const input = document.getElementById('agent-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    const messages = document.getElementById('agent-messages');

    // Remove welcome if present
    const welcome = messages.querySelector('.agent-welcome');
    if (welcome) welcome.remove();

    // Add user message
    const userEl = document.createElement('div');
    userEl.className = 'agent-msg user';
    userEl.textContent = msg;
    messages.appendChild(userEl);

    // Loading indicator
    const loadEl = document.createElement('div');
    loadEl.className = 'agent-msg loading';
    loadEl.textContent = 'Thinking';
    messages.appendChild(loadEl);
    messages.scrollTop = messages.scrollHeight;

    // Gather context
    const provider = document.getElementById('agent-provider').value;
    const currentFile = IDE.activeTab ? {
        path: IDE.activeTab.path,
        content: IDE.activeTab.model.getValue()
    } : null;

    try {
        const res = await fetch('/agent/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: msg,
                provider: provider,
                container: IDE.container,
                current_file: currentFile,
            })
        });

        loadEl.remove();

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Agent unavailable' }));
            const errEl = document.createElement('div');
            errEl.className = 'agent-msg error';
            errEl.textContent = err.error || err.detail || 'Agent error';
            messages.appendChild(errEl);
        } else {
            const data = await res.json();
            const assistEl = document.createElement('div');
            assistEl.className = 'agent-msg assistant';
            assistEl.innerHTML = formatAgentResponse(data.response || data.message || JSON.stringify(data));
            messages.appendChild(assistEl);

            // If agent suggests file changes, add apply buttons
            if (data.file_changes && data.file_changes.length > 0) {
                data.file_changes.forEach(change => {
                    const applyBtn = document.createElement('button');
                    applyBtn.className = 'agent-apply-btn';
                    applyBtn.textContent = `Apply to ${change.path}`;
                    applyBtn.onclick = () => applyAgentChange(change);
                    assistEl.appendChild(applyBtn);
                });
            }
        }
    } catch (e) {
        loadEl.remove();
        const errEl = document.createElement('div');
        errEl.className = 'agent-msg error';
        errEl.textContent = 'Agent service unavailable. Start the Python agent: cd agent && python main.py';
        messages.appendChild(errEl);
    }

    messages.scrollTop = messages.scrollHeight;
}

function formatAgentResponse(text) {
    // Simple markdown-like formatting
    // Code blocks
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
    // Inline code
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Newlines
    text = text.replace(/\n/g, '<br>');
    return text;
}

async function applyAgentChange(change) {
    try {
        const res = await fetch('/file/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                container: IDE.container,
                path: change.path,
                content: change.content
            })
        });
        if (res.ok) {
            showToast('Applied changes to ' + change.path, 'success');
            // Reload file if open
            const tab = IDE.tabs.find(t => t.path === change.path);
            if (tab) {
                tab.model.setValue(change.content);
                tab.original = change.content;
                tab.modified = false;
                renderTabs();
            }
            loadFileTree();
        } else {
            showToast('Failed to apply changes', 'error');
        }
    } catch (e) {
        showToast('Apply error', 'error');
    }
}

// Agent input Enter key
document.addEventListener('DOMContentLoaded', () => {
    const agentInput = document.getElementById('agent-input');
    if (agentInput) {
        agentInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') sendAgentMessage();
        });
    }
});
