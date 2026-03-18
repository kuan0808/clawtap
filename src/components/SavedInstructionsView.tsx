import { useState, useEffect } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { SavedInstruction } from '@/types/adapter';

export function SavedInstructionsView({ onBack }: { onBack: () => void }) {
  const [instructions, setInstructions] = useState<SavedInstruction[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newInstruction, setNewInstruction] = useState('');

  useEffect(() => {
    api.getInstructions().then(setInstructions).catch(() => {});
  }, []);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this instruction?')) return;
    try {
      await api.deleteInstruction(id);
      setInstructions((prev) => prev.filter((i) => i.id !== id));
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    if (!newLabel.trim() || !newInstruction.trim()) return;
    try {
      const created = await api.createInstruction(newLabel.trim(), newInstruction.trim());
      setInstructions((prev) => [
        ...prev,
        { ...created, created_at: new Date().toISOString() },
      ]);
      setNewLabel('');
      setNewInstruction('');
      setShowAddForm(false);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-border">
        <button
          onClick={onBack}
          className="text-text-dim hover:text-text mr-2"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <span className="font-medium text-text font-mono tracking-wide">Saved Instructions</span>
        <div className="flex-1" />
        <button
          onClick={() => setShowAddForm(true)}
          className="text-accent text-sm font-medium"
        >
          + Add
        </button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="px-4 py-3 border-b border-border space-y-2">
          <input
            type="text"
            placeholder="名稱"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="w-full bg-surface border border-border rounded-md px-3 py-2 text-text text-sm outline-none focus:border-accent"
          />
          <textarea
            placeholder="Instruction 內容..."
            value={newInstruction}
            onChange={(e) => setNewInstruction(e.target.value)}
            rows={4}
            className="w-full bg-surface border border-border rounded-md px-3 py-2 text-text text-sm outline-none focus:border-accent resize-none"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewLabel('');
                setNewInstruction('');
              }}
              className="px-3 py-1.5 text-sm text-text-dim hover:text-text rounded-md"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 text-sm bg-accent hover:bg-accent/80 text-white rounded-md"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {instructions.length === 0 && !showAddForm && (
          <div className="flex-1 flex items-center justify-center text-text-dim text-sm h-full">
            No saved instructions
          </div>
        )}
        {instructions.map((item) => (
          <div
            key={item.id}
            className="bg-surface border border-border rounded-md px-4 py-3 flex items-start gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-text text-sm">{item.label}</div>
              <div className="text-text-dim text-xs mt-1 line-clamp-2">
                {item.instruction}
              </div>
            </div>
            <button
              onClick={() => handleDelete(item.id)}
              className="text-red-400/60 hover:text-red-400 shrink-0 mt-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
