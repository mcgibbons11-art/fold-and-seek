import type { ReactElement } from "react";

/** A code-native folded mechanism used as quiet key art behind menu copy. */
export function FoldedObjectMark(): ReactElement {
  return (
    <div className="fs-folded-mark" aria-hidden>
      <span className="fs-folded-mark__orbit" />
      <span className="fs-folded-mark__plate fs-folded-mark__plate--a" />
      <span className="fs-folded-mark__plate fs-folded-mark__plate--b" />
      <span className="fs-folded-mark__plate fs-folded-mark__plate--c" />
      <span className="fs-folded-mark__hub" />
    </div>
  );
}
