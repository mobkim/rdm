import { useState, useEffect, useCallback } from 'react';
import { X, Copy, Trash2, RefreshCw, FolderOpen, MoveRight } from 'lucide-react';

interface FileEntry {
    name: string;
    size: number;
    modified: string;
}

interface Session {
    instanceId: string;
    name: string;
}

interface Props {
    sessions: Session[];
    /** Pre-select this instance as the source when the panel opens. */
    fromInstanceId?: string;
    apiBase: string;
    onClose: () => void;
}

const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const FileTransferPanel: React.FC<Props> = ({ sessions, fromInstanceId, apiBase, onClose }) => {
    const [fromId, setFromId] = useState(fromInstanceId || sessions[0]?.instanceId || '');
    const [toId, setToId] = useState('');
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [transferring, setTransferring] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');

    const loadFiles = useCallback(async (instanceId: string) => {
        if (!instanceId) return;
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${apiBase}/files/${instanceId}`);
            if (!res.ok) throw new Error(await res.text());
            setFiles(await res.json());
        } catch (e: any) {
            setError(e.message || 'Failed to load files');
            setFiles([]);
        } finally {
            setLoading(false);
        }
    }, [apiBase]);

    useEffect(() => {
        loadFiles(fromId);
    }, [fromId, loadFiles]);

    // Pick a sensible default destination whenever the source or session list changes.
    useEffect(() => {
        const other = sessions.find(s => s.instanceId !== fromId);
        setToId(prev => {
            // Keep the current selection if it's valid and different from source.
            if (prev && prev !== fromId && sessions.some(s => s.instanceId === prev)) return prev;
            return other?.instanceId || '';
        });
    }, [sessions, fromId]);

    const handleTransfer = async (filename: string) => {
        if (!toId) return;
        setTransferring(filename);
        setError('');
        setSuccessMsg('');
        try {
            const res = await fetch(`${apiBase}/files/transfer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fromInstanceId: fromId, toInstanceId: toId, filename })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Transfer failed');
            const destName = sessions.find(s => s.instanceId === toId)?.name || toId;
            setSuccessMsg(`"${filename}" copied to ${destName}`);
        } catch (e: any) {
            setError(e.message || 'Transfer failed');
        } finally {
            setTransferring(null);
        }
    };

    const handleDelete = async (filename: string) => {
        setDeleting(filename);
        setError('');
        try {
            const res = await fetch(`${apiBase}/files/${fromId}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
            setFiles(prev => prev.filter(f => f.name !== filename));
        } catch (e: any) {
            setError(e.message || 'Failed to delete file');
        } finally {
            setDeleting(null);
        }
    };

    const destOptions = sessions.filter(s => s.instanceId !== fromId);

    return (
        <div className="fixed inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-700 shadow-2xl z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
                <h2 className="text-white font-semibold flex items-center gap-2">
                    <FolderOpen size={16} className="text-blue-400" />
                    File Transfer
                </h2>
                <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
                    <X size={18} />
                </button>
            </div>

            {/* Source / destination pickers */}
            <div className="px-4 py-3 border-b border-slate-700 space-y-2 shrink-0">
                <div>
                    <label className="text-xs text-slate-400 block mb-1">From server</label>
                    <select
                        value={fromId}
                        onChange={e => { setFromId(e.target.value); setFiles([]); setSuccessMsg(''); }}
                        className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm outline-none focus:border-blue-500"
                    >
                        {sessions.map(s => <option key={s.instanceId} value={s.instanceId}>{s.name}</option>)}
                    </select>
                </div>
                <div className="flex items-center gap-1 text-slate-500 text-xs">
                    <MoveRight size={14} />
                    <span>copy to</span>
                </div>
                <div>
                    <select
                        value={toId}
                        onChange={e => setToId(e.target.value)}
                        disabled={destOptions.length === 0}
                        className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {destOptions.length === 0
                            ? <option value="">— connect another server first —</option>
                            : destOptions.map(s => <option key={s.instanceId} value={s.instanceId}>{s.name}</option>)
                        }
                    </select>
                </div>
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-400 uppercase tracking-wider">Staged files</span>
                    <button
                        onClick={() => loadFiles(fromId)}
                        disabled={loading}
                        className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition-colors"
                        title="Refresh file list"
                    >
                        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>

                {error && <p className="text-red-400 text-sm mb-3 leading-snug">{error}</p>}
                {successMsg && <p className="text-emerald-400 text-sm mb-3 leading-snug">{successMsg}</p>}

                {!loading && files.length === 0 && (
                    <div className="text-center py-10 px-2">
                        <FolderOpen size={32} className="mx-auto text-slate-700 mb-3" />
                        <p className="text-slate-500 text-sm">No files staged</p>
                        <p className="text-slate-600 text-xs mt-2 leading-relaxed">
                            In Windows Explorer, copy files to the <span className="text-slate-400 font-medium">RDM Transfer</span> drive to stage them here.
                        </p>
                    </div>
                )}

                <ul className="space-y-2">
                    {files.map(file => (
                        <li key={file.name} className="bg-slate-800 rounded-lg px-3 py-2.5 flex items-center gap-2 group">
                            <div className="flex-1 min-w-0">
                                <p className="text-white text-sm truncate" title={file.name}>{file.name}</p>
                                <p className="text-slate-500 text-xs">{formatSize(file.size)}</p>
                            </div>
                            <button
                                onClick={() => handleTransfer(file.name)}
                                disabled={!toId || !!transferring || !!deleting}
                                title={toId
                                    ? `Copy to ${sessions.find(s => s.instanceId === toId)?.name}`
                                    : 'Select a destination first'}
                                className="shrink-0 p-1.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                <Copy size={13} className={transferring === file.name ? 'animate-pulse' : ''} />
                            </button>
                            <button
                                onClick={() => handleDelete(file.name)}
                                disabled={!!transferring || !!deleting}
                                title="Remove from staging area"
                                className="shrink-0 p-1.5 rounded text-slate-600 hover:text-red-400 hover:bg-red-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                <Trash2 size={13} className={deleting === file.name ? 'animate-pulse' : ''} />
                            </button>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Footer hint */}
            <div className="px-4 py-3 border-t border-slate-700 shrink-0">
                <p className="text-xs text-slate-600 leading-relaxed">
                    Files saved to the <span className="text-slate-500">RDM Transfer</span> virtual drive in Windows are staged here and can be copied to any other connected server's drive.
                </p>
            </div>
        </div>
    );
};
