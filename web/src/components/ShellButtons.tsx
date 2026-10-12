// The two buttons every page header carries on a phone, where the sidebar is a drawer: open the
// drawer, and "needs you" (one item: go there; several: open the drawer, whose list names them).
import { useAttention } from '../attention';
import { setDrawer, useStore } from '../store';
import { Icon } from './ui';
import { BackendMark } from './Backend';

export function DrawerButton() {
  const count = useAttention(useStore((s) => s.app)).length;
  return (
    <button className="btn btn-ghost btn-icon drawer-btn show-phone" onClick={() => setDrawer(true)} aria-label="Menu" title="Sandboxes, machines and agents">
      <Icon name="menu" />
      <BackendMark />
      {count > 0 && <span className="drawer-dot" aria-hidden />}
    </button>
  );
}

export function AttentionButton() {
  const items = useAttention(useStore((s) => s.app));
  if (!items.length) return null;
  return (
    <button
      className="needs-you show-phone"
      onClick={() => (items.length === 1 ? items[0].open() : setDrawer(true))}
      title={items.length === 1 ? `${items[0].title}: ${items[0].detail}` : `${items.length} things wait on you`}
      aria-label={`${items.length} waiting on you`}
    >
      <Icon name="bell" size={15} /> {items.length}
    </button>
  );
}
