// index.tsx

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Terminal, Play, Cpu, FileText, Activity } from 'lucide-react';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

const USER_ID = '00000000-0000-0000-0000-000000000000';

export default function AgentConsole() {
  const [logs, setLogs] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [proposals, setProposals] = useState<any[]>([]);

  // Fetch the "Brain" output (Action Proposals)
  const fetchProposals = async () => {
    const { data } = await supabase
      .from('action_proposals')
      .select('*')
      .eq('user_id', USER_ID)
      .order('created_at', { ascending: false })
      .limit(20);
    setProposals(data || []);
  };

  useEffect(() => {
    fetchProposals();
  }, []);

  const runAgent = async () => {
    setIsRunning(true);
    setLogs(prev => [`> Initializing Agent Loop for ${USER_ID}...`, ...prev]);

    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST',
        body: JSON.stringify({ userId: USER_ID })
      });
      const data = await res.json();

      if (data.success) {
        setLogs(prev => [`> Processed ${data.processed} emails.`, ...prev]);
        data.results.forEach((r: any) => {
          setLogs(prev => [`> [${r.action}] Priority: ${r.priority} - ${r.emailId}`, ...prev]);
        });
        await fetchProposals(); // Refresh view
      } else {
        setLogs(prev => [`> ERROR: ${data.error}`, ...prev]);
      }
    } catch (e: any) {
      setLogs(prev => [`> FATAL: ${e.message}`, ...prev]);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-slate-300 font-mono p-8">

      {/* Control Bar */}
      <div className="max-w-6xl mx-auto flex justify-between items-center mb-8 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-3">
            <Cpu className="w-6 h-6 text-emerald-500" />
            AGENT_RUNTIME_V1
          </h1>
          <p className="text-xs text-slate-500 mt-1">Direct Interface to api/agent/run</p>
        </div>
        <button
          onClick={runAgent}
          disabled={isRunning}
          className={`flex items-center gap-2 px-6 py-2 rounded-sm text-sm font-bold uppercase tracking-wider transition-all ${
            isRunning
            ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
            : 'bg-emerald-600 text-white hover:bg-emerald-500 hover:shadow-[0_0_20px_rgba(16,185,129,0.3)]'
          }`}
        >
          {
