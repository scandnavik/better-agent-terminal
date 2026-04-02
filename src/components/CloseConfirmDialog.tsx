import { useTranslation } from 'react-i18next'

interface CloseConfirmDialogProps {
  onConfirm: () => void
  onCancel: () => void
  isWorktree?: boolean
  onConfirmAndClean?: () => void
}

export function CloseConfirmDialog({ onConfirm, onCancel, isWorktree, onConfirmAndClean }: CloseConfirmDialogProps) {
  const { t } = useTranslation()

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>{t('dialogs.closeCodeAgent')}</h3>
        <p>
          {isWorktree
            ? 'Close this agent session? You can also clean up the worktree.'
            : t('dialogs.closeCodeAgentConfirm')}
        </p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          {isWorktree && onConfirmAndClean && (
            <button className="dialog-btn confirm danger" onClick={onConfirmAndClean}>
              Close & Clean Worktree
            </button>
          )}
          <button className="dialog-btn confirm" onClick={onConfirm}>
            {isWorktree ? 'Close (Keep Worktree)' : t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
