import { useRef, useState } from 'react';

/** Run one modal action without dropping its form state when storage rejects. */
export function useModalAction(onClose, failureMessage = 'Could not save this change. Your entries are still here; please try again.') {
  const busyRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const dismiss = () => {
    if (!busyRef.current) onClose?.();
  };

  const run = async (action) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setIsSubmitting(true);
    setError('');
    let completed = false;

    try {
      await action();
      completed = true;
      onClose?.();
      return true;
    } catch (problem) {
      console.warn('Modal action failed', problem);
      setError(failureMessage);
      return false;
    } finally {
      busyRef.current = false;
      // On success the modal unmounts. Avoid scheduling state on that tree.
      if (!completed) setIsSubmitting(false);
    }
  };

  return { run, dismiss, error, isSubmitting };
}
