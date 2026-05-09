// Static reference for the commit-graph right-click menu. Kept in the left
// sidebar so it doesn't compete with the graph or the working-tree pane.

export function LeftDocs(): JSX.Element {
  return (
    <div className="left-docs-pane">
      <p className="left-docs-lead">
        Right-click a <strong>commit node</strong> (or the row) on the graph to open this menu. Items
        that change history or the working tree ask for confirmation when you have uncommitted changes, or
        block while a merge/rebase is in progress.
      </p>

      <table className="left-docs-table">
        <thead>
          <tr>
            <th>Menu item</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono">Checkout this commit (detached)</td>
            <td>
              Moves <code>HEAD</code> to that commit. You are no longer on a branch until you check out a
              branch again or create one from here.
            </td>
          </tr>
          <tr>
            <td className="mono">Create branch from this commit…</td>
            <td>
              Opens a dialog to create a new branch starting at this commit. Use this instead of the old
              sidebar &quot;New branch&quot; button.
            </td>
          </tr>
          <tr>
            <td className="mono">Cherry-pick onto …</td>
            <td>
              Replays this commit&apos;s patch on top of your <strong>current branch</strong>. Disabled when
              this commit is already <code>HEAD</code>.
            </td>
          </tr>
          <tr>
            <td className="mono">Revert this commit</td>
            <td>
              Creates a new commit that undoes this one&apos;s changes (safe for shared history). May
              produce conflicts like any other merge.
            </td>
          </tr>
          <tr>
            <td className="mono">Merge into …</td>
            <td>
              Merges <strong>this commit</strong> (as a ref) into your current branch. Same idea as merging a
              branch tip that points here.
            </td>
          </tr>
          <tr>
            <td className="mono">Rebase … onto this commit</td>
            <td>
              Replays your current branch&apos;s commits on top of this commit. Not shown as useful when this
              commit is already <code>HEAD</code>.
            </td>
          </tr>
          <tr>
            <td className="mono">Push current → …</td>
            <td>
              One entry per <strong>local branch label</strong> shown on that commit, except your{' '}
              <strong>current</strong> branch. Runs{' '}
              <code className="nowrap">
                git push origin &lt;current&gt;:&lt;target-branch&gt;
              </code>{' '}
              — updates the remote ref for that branch to match your local branch tip. Hidden when you are in
              detached <code>HEAD</code> (no named current branch).
            </td>
          </tr>
          <tr>
            <td className="mono">Copy hash / Copy short hash</td>
            <td>Copies the full or 7-character SHA to the clipboard.</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
