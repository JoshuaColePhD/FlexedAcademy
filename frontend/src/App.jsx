import React, { useState, useRef, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { Mic, Square, Loader2, ArrowUp, FileText, User, Sparkles, MessageSquare, Plus, ChevronDown, Download, X, Home, Code, Folder, Clock, Users, Settings, Pin, FlaskConical, LayoutTemplate, Search, PanelLeft } from 'lucide-react';
import './index.css';

// Placeholder Component for unbuilt routes
const Placeholder = ({ title }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'var(--text-muted)' }}>
    <FileText size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
    <h2>{title}</h2>
    <p style={{ marginTop: '0.5rem' }}>This page is coming soon.</p>
  </div>
);

const LessonPlanArtifact = ({ data, onRewriteDay, rawJson }) => {
  const [editingDayIdx, setEditingDayIdx] = useState(null);
  const [rewriteFeedback, setRewriteFeedback] = useState('');
  
  if (!data || !data.days) {
    if (rawJson) {
      return (
        <div className="artifact-loading" style={{ padding: '1rem', overflowY: 'auto' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>Generating...</div>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.85rem' }}>{rawJson}</pre>
        </div>
      );
    }
    return <div className="artifact-loading">Generating preview...</div>;
  }
  
  return (
    <div className="lesson-plan-artifact">
      <div className="lesson-plan-header">
        <h2>{data.week_of}</h2>
        <p>{data.teacher} • {data.course} • {data.period}</p>
      </div>
      <div className="lesson-days">
        {data.days.map((day, idx) => (
          <div key={idx} className="lesson-day-card">
            <div className="day-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-light)', marginBottom: '1rem', paddingBottom: '0.5rem' }}>
               <h3 className="day-name" style={{ borderBottom: 'none', margin: 0, padding: 0 }}>{day.name} {day.no_school ? '(No School)' : ''}</h3>
               {!day.no_school && (
                 <button className="btn-icon-small" onClick={() => setEditingDayIdx(editingDayIdx === idx ? null : idx)}>
                    <Sparkles size={14}/>
                 </button>
               )}
            </div>
            
            {editingDayIdx === idx && (
               <div className="rewrite-box" style={{ background: 'var(--bg-muted)', padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    placeholder="e.g. Make the Do Now a group activity..." 
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-light)' }}
                    value={rewriteFeedback}
                    onChange={(e) => setRewriteFeedback(e.target.value)}
                    onKeyDown={(e) => {
                       if (e.key === 'Enter') {
                          onRewriteDay(idx, day, rewriteFeedback);
                          setEditingDayIdx(null);
                          setRewriteFeedback('');
                       }
                    }}
                  />
                  <button className="btn-icon-small active-blue" onClick={() => {
                     onRewriteDay(idx, day, rewriteFeedback);
                     setEditingDayIdx(null);
                     setRewriteFeedback('');
                  }}>
                     <ArrowUp size={14}/>
                  </button>
               </div>
            )}
            
            {!day.no_school && (
              <div className="day-details">
                <div className="lesson-field">
                  <span className="lesson-field-label">Standards</span>
                  <span className="lesson-field-value">{day.standards}</span>
                </div>
                <div className="lesson-field">
                  <span className="lesson-field-label">ACT Alignment</span>
                  <span className="lesson-field-value">{day.act_alignment}</span>
                </div>
                <div className="lesson-field">
                  <span className="lesson-field-label">Learning Targets</span>
                  <span className="lesson-field-value">{day.learning_targets}</span>
                </div>
                <div className="lesson-field">
                  <span className="lesson-field-label">Engagement Strategy</span>
                  <span className="lesson-field-value">{day.engagement_strategy}</span>
                </div>
                <div className="lesson-field">
                  <span className="lesson-field-label">Lesson (Do Now / During / Assessment)</span>
                  <span className="lesson-field-value" style={{whiteSpace: 'pre-line'}}>{day.lesson}</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

function MainApp() {
  const navigate = useNavigate();
  const location = useLocation();

  const [chats, setChats] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState([]);
  
  // Artifact State
  const [activeArtifact, setActiveArtifact] = useState(null);
  const [isArtifactOpen, setIsArtifactOpen] = useState(false);

  const mediaRecorder = useRef(null);
  const audioChunks = useRef([]);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const saved = localStorage.getItem('lesson_chats');
    if (saved) setChats(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (messages.length > 0 && currentChatId) {
      setChats(prev => {
        const updated = prev.map(c => c.id === currentChatId ? { ...c, messages } : c);
        localStorage.setItem('lesson_chats', JSON.stringify(updated));
        return updated;
      });
    }
  }, [messages, currentChatId]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '24px';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = Math.min(scrollHeight, 200) + 'px';
    }
  }, [query]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);
  
  const handleNewChat = () => {
    setCurrentChatId(null);
    setMessages([]);
    setQuery('');
    setActiveArtifact(null);
    setIsArtifactOpen(false);
    navigate('/');
  };
  
  const loadChat = (chatId) => {
    const chat = chats.find(c => c.id === chatId);
    if (chat) {
      setCurrentChatId(chat.id);
      setMessages(chat.messages);
      
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg && lastMsg.type === 'artifact') {
        setActiveArtifact(lastMsg);
        setIsArtifactOpen(false);
      } else {
        setActiveArtifact(null);
        setIsArtifactOpen(false);
      }
      navigate('/');
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];
      mediaRecorder.current.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.current.push(event.data);
      };
      mediaRecorder.current.onstop = async () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        await handleTranscription(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorder.current.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      alert("Microphone access denied or not available.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && isRecording) {
      mediaRecorder.current.stop();
      setIsRecording(false);
    }
  };

  const handleTranscription = async (audioBlob) => {
    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      const response = await fetch('http://localhost:8000/api/transcribe', {
        method: 'POST',
        body: formData
      });
      if (!response.ok) throw new Error('Transcription failed');
      const data = await response.json();
      setQuery(prev => {
        const text = prev.trim();
        return text ? `${text} ${data.text}` : data.text;
      });
    } catch (err) {
      console.error(err);
      alert("Transcription error: " + err.message);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    setIsGenerating(true);
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const response = await fetch('http://localhost:8000/api/extract_text', {
        method: 'POST',
        body: formData
      });
      if (!response.ok) throw new Error('File extraction failed');
      const data = await response.json();
      setAttachedFiles(prev => [...prev, { filename: data.filename, text: data.text }]);
    } catch (err) {
      console.error(err);
      alert('Error extracting text from file.');
    } finally {
      setIsGenerating(false);
      event.target.value = ''; // Reset input
    }
  };

  const handleGenerate = async () => {
    if (!query.trim() && attachedFiles.length === 0) return;
    if (isGenerating) return;
    
    let fullQuery = query.trim();
    if (attachedFiles.length > 0) {
      fullQuery += "\n\n--- Attached Context ---\n";
      attachedFiles.forEach(f => {
        fullQuery += `\nDocument: ${f.filename}\n${f.text}\n`;
      });
    }
    
    const userMessage = { role: 'user', content: query.trim() || 'Attached files for context.' };
    
    let activeChatId = currentChatId;
    if (!activeChatId) {
      activeChatId = Date.now().toString();
      setCurrentChatId(activeChatId);
      const title = userMessage.content.split('\n')[0].slice(0, 30) + (userMessage.content.length > 30 ? "..." : "");
      setChats(prev => {
        const updated = [{ id: activeChatId, title, messages: [userMessage] }, ...prev];
        localStorage.setItem('lesson_chats', JSON.stringify(updated));
        return updated;
      });
    }
    
    setMessages(prev => [...prev, userMessage]);
    setQuery('');
    setAttachedFiles([]);
    setIsGenerating(true);
    setActiveArtifact(null);
    setIsArtifactOpen(false);
    
    try {
      const response = await fetch('http://localhost:8000/api/generate_stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: fullQuery })
      });
      
      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;
      let rawJson = '';
      
      const assistantMsg = { 
        role: 'assistant', 
        content: 'Generating lesson plan...',
        type: 'artifact',
        fileId: null,
        previewData: null
      };
      
      setMessages(prev => [...prev, assistantMsg]);
      setActiveArtifact(assistantMsg);
      setIsArtifactOpen(true);
      setIsGenerating(false); // We show typing indicator in the message text now
      
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.replace('data: ', '');
              try {
                const data = JSON.parse(dataStr);
                
                if (data.error) {
                   throw new Error(data.error);
                }
                
                if (data.chunk) {
                   rawJson += data.chunk;
                   // Attempt to aggressively parse the partial JSON for live rendering
                   let parsedData = null;
                   try {
                     parsedData = JSON.parse(rawJson + ']}'); // try to close the array/object
                   } catch (e) {
                     // ignore partial JSON parse errors
                   }
                   
                   setMessages(prev => {
                     const newMsgs = [...prev];
                     const lastMsg = newMsgs[newMsgs.length - 1];
                     // Only try to attach parsed data if we got something
                     if (parsedData && parsedData.days) {
                         lastMsg.previewData = parsedData;
                     }
                     lastMsg.rawJson = rawJson;
                     return newMsgs;
                   });
                   // Also update active artifact if it's the current one
                   setActiveArtifact(prev => {
                     if (!prev) return prev;
                     return { ...prev, previewData: parsedData || prev.previewData, rawJson };
                   });
                }
                
                if (data.done) {
                   const finalData = JSON.parse(rawJson);
                   setMessages(prev => {
                     const newMsgs = [...prev];
                     const lastMsg = newMsgs[newMsgs.length - 1];
                     lastMsg.content = 'I have generated your lesson plan. You can view the artifacts in the right panel.';
                     lastMsg.fileId = data.file_id;
                     lastMsg.previewData = finalData;
                     return newMsgs;
                   });
                   setActiveArtifact(prev => ({ ...prev, fileId: data.file_id, previewData: finalData }));
                }
              } catch (e) {
                // Ignore empty or malformed lines from SSE
              }
            }
          }
        }
      }
      
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `Error generating lesson plan: ${err.message}` 
      }]);
    } finally {
      setIsGenerating(false);
    }
  };
  
  const handleRewriteDay = async (dayIdx, dayData, feedback) => {
     if (!feedback.trim()) return;
     const userMessage = { role: 'user', content: `Rewrite ${dayData.name}: ${feedback}` };
     setMessages(prev => [...prev, userMessage]);
     setIsGenerating(true);
     
     try {
       const response = await fetch('http://localhost:8000/api/rewrite_day', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ 
           day_json: JSON.stringify(dayData), 
           feedback: feedback,
           full_plan_context: JSON.stringify(activeArtifact?.previewData)
         })
       });
       if (!response.ok) throw new Error('Rewrite failed');
       const updatedDay = await response.json();
       
       setActiveArtifact(prev => {
          if (!prev || !prev.previewData) return prev;
          const newDays = [...prev.previewData.days];
          newDays[dayIdx] = updatedDay;
          const newPreviewData = { ...prev.previewData, days: newDays };
          
          setMessages(msgs => {
             const newMsgs = [...msgs];
             const lastMsg = newMsgs[newMsgs.length - 1];
             if (lastMsg.type === 'artifact') {
                 lastMsg.previewData = newPreviewData;
             }
             return newMsgs;
          });
          
          return { ...prev, previewData: newPreviewData };
       });
       
       setMessages(prev => [...prev, { 
         role: 'assistant', 
         content: `I have updated ${dayData.name} based on your feedback. Check the artifact panel.`,
       }]);
       
     } catch (err) {
       console.error(err);
       setMessages(prev => [...prev, { role: 'assistant', content: `Error rewriting day: ${err.message}` }]);
     } finally {
       setIsGenerating(false);
     }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const renderChatInterface = () => (
    <>
      <div className="chat-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h1>How can I help you teach?</h1>
          </div>
        ) : (
          <div className="chat-history">
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="message-avatar avatar-assistant">
                    <img src="/logo.png" alt="AI" style={{ width: '100%', height: '100%', borderRadius: '4px' }} />
                  </div>
                )}
                <div className="message-content">
                  <p className="message-text">{msg.content}</p>
                  {msg.type === 'artifact' && (
                    <div className="inline-artifact-card" onClick={() => setIsArtifactOpen(true)}>
                       <FileText size={16} />
                       <div>
                          <span>Lesson Plan Generation</span>
                          <small>Document • Click to view in panel</small>
                       </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isGenerating && (
              <div className="message assistant">
                <div className="message-avatar avatar-assistant">
                  <img src="/logo.png" alt="AI" style={{ width: '100%', height: '100%', borderRadius: '4px' }} />
                </div>
                <div className="message-content">
                  <div className="typing-indicator">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        <div className="input-area-wrapper">
          <div className="attached-files-container" style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
             {attachedFiles.map((file, idx) => (
                <div key={idx} style={{ background: 'var(--bg-muted)', padding: '0.25rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                   <FileText size={12}/> {file.filename}
                   <button onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><X size={12}/></button>
                </div>
             ))}
          </div>
          <div className={`input-box ${isRecording ? 'recording' : ''}`}>
             <textarea
                ref={textareaRef}
                className="query-input"
                placeholder={isRecording ? "Listening..." : "Write a message..."}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isGenerating || isRecording || isTranscribing}
                rows={1}
                style={{ width: '100%', padding: '1rem 1.25rem 0.5rem', minHeight: '50px' }}
              />
            <div className="input-bottom-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0.75rem 0.75rem 0.75rem', alignItems: 'center' }}>
               <label className="btn-icon-small" style={{ cursor: 'pointer' }}>
                 <Plus size={18}/>
                 <input type="file" accept=".pdf,.txt,.md,.csv" onChange={handleFileUpload} style={{ display: 'none' }} />
               </label>
               
               <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                 <div className="model-selector" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, marginRight: '0.5rem', cursor: 'pointer', padding: '0.25rem 0.5rem', borderRadius: '4px' }}>
                    Sonnet 5 Medium <ChevronDown size={12} />
                 </div>
                 {isTranscribing ? (
                    <button className="btn-icon-small" disabled><Loader2 size={16} className="spin-anim" /></button>
                  ) : isRecording ? (
                    <button className="btn-icon-small active-record" onClick={stopRecording}><Square size={16} fill="currentColor" /></button>
                  ) : (
                    <button className="btn-icon-small" onClick={startRecording} disabled={isGenerating}><Mic size={16} /></button>
                  )}
                  <button className="btn-icon-small"><Settings size={16} /></button>
                  <button className="btn-icon-submit" onClick={handleGenerate} disabled={!query.trim() || isGenerating || isRecording || isTranscribing} style={{ marginLeft: '0.25rem' }}>
                    <ArrowUp size={16} strokeWidth={3} />
                  </button>
               </div>
            </div>
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
             Claude is AI and can make mistakes. Please double-check responses.
          </div>
        </div>
      </div>
      
      {/* Right Artifact Panel Overhaul */}
      {(activeArtifact && isArtifactOpen) && (
        <div className="artifact-panel">
          <div className="artifact-header">
            <div className="artifact-header-left">Generated Lesson Plan</div>
            <div className="artifact-header-right">
              <a href={`http://localhost:8000/api/download/${activeArtifact.fileId}`} download="Lesson_Plan.docx" className="btn-download-small">
                <Download size={14}/> Download DOCX
              </a>
              <button className="btn-icon-small" onClick={() => setIsArtifactOpen(false)} style={{marginLeft: '0.5rem'}}>
                <X size={14}/>
              </button>
            </div>
          </div>
          <div className="artifact-content-scrollable" style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
            <LessonPlanArtifact data={activeArtifact.previewData} onRewriteDay={handleRewriteDay} rawJson={activeArtifact.rawJson} />
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="app-layout">
      <div className="app-body">
        {/* Sidebar Overhaul (Claude Style) */}
        <div className="sidebar">
          <div className="sidebar-top">
            <div className="header-logo" style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, fontSize: '1.1rem' }}>
              <img src="/logo.png" alt="Logo" style={{ width: 24, height: 24, borderRadius: 6 }} />
              AP Lang Planner
            </div>
            
            <div className="sidebar-nav">
              <button className="nav-btn" onClick={handleNewChat}><Plus size={14}/> New</button>
              <Link to="/projects" className={`nav-btn ${location.pathname === '/projects' ? 'active-link' : ''}`}><Folder size={14}/> Projects</Link>
              <Link to="/artifacts" className={`nav-btn ${location.pathname === '/artifacts' ? 'active-link' : ''}`}><FileText size={14}/> Artifacts</Link>
              <Link to="/scheduled" className={`nav-btn ${location.pathname === '/scheduled' ? 'active-link' : ''}`}><Clock size={14}/> Scheduled</Link>
              <Link to="/teachers" className={`nav-btn ${location.pathname === '/teachers' ? 'active-link' : ''}`}><Users size={14}/> Teachers</Link>
              <Link to="/customize" className={`nav-btn ${location.pathname === '/customize' ? 'active-link' : ''}`}><Settings size={14}/> Customize</Link>
            </div>
          </div>
          
          <div className="sidebar-content">
            <div className="sidebar-section-title">Pinned</div>
            <div className="chat-history-item"><Pin size={12}/> AP Lang Pacing Guide</div>
            <div className="chat-history-item"><Pin size={12}/> State Standards</div>
            
            <div className="sidebar-section-title" style={{marginTop: '1.5rem'}}>Recents</div>
            {chats.map(chat => (
              <div 
                key={chat.id} 
                className={`chat-history-item ${currentChatId === chat.id && location.pathname === '/' ? 'active' : ''}`}
                onClick={() => loadChat(chat.id)}
              >
                <MessageSquare size={12} />
                {chat.title}
              </div>
            ))}
          </div>
          
          <div className="sidebar-footer">
            <div className="user-avatar">JC</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
               <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>Josh Cole</span>
               <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>jpcole@florencek12.al.us</span>
            </div>
          </div>
        </div>

        {/* Main Content Overhaul */}
        <div className="main-content">
          <Routes>
            <Route path="/" element={renderChatInterface()} />
            <Route path="/projects" element={<Placeholder title="Projects" />} />
            <Route path="/artifacts" element={<Placeholder title="Artifacts" />} />
            <Route path="/scheduled" element={<Placeholder title="Scheduled" />} />
            <Route path="/teachers" element={<Placeholder title="Teachers" />} />
            <Route path="/customize" element={<Placeholder title="Customize" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <MainApp />
    </BrowserRouter>
  );
}

export default App;
