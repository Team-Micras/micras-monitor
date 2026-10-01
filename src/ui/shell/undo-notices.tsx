import { DeletedNotice } from './deleted-notice';
import { RemovedVariableNotice } from './removed-variable-notice';

/** The notices of removals that can be undone: a deleted layout, a variable taken out. */
export function UndoNotices() {
  return (
    <>
      <DeletedNotice />
      <RemovedVariableNotice />
    </>
  );
}
