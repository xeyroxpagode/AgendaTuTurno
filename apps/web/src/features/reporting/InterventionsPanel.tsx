"use client";

import { BlockView } from "./BlockView";
import { InterventionCards, type LinkBuilder } from "./shared";
import type { Block, Intervention, InterventionsResponse } from "./api";
import { formatCount } from "./format";

/** J4 · Causas vigentes: sin mark-read, sin dismiss, sin escritura. */
export function InterventionsPanel({
  response,
  link,
  failureBlock,
  onRetry,
}: {
  response: InterventionsResponse | null;
  link: LinkBuilder;
  failureBlock: <T>() => Block<T> | undefined;
  onRetry: () => void;
}) {
  const block: Block<Intervention[]> | undefined = response
    ? {
      state: response.state,
      data: response.items,
      completeness: response.completeness,
      asOf: response.asOf,
      interval: response.interval,
    }
    : failureBlock<Intervention[]>();

  return (
    <BlockView
      title="Causas vigentes que requieren intervención"
      block={block}
      onRetry={onRetry}
      render={(items) => (
        <div className="report-stack">
          <p className="muted">Cantidad informada: {formatCount(items.length)}</p>
          <InterventionCards items={items} link={link} />
        </div>
      )}
    />
  );
}
