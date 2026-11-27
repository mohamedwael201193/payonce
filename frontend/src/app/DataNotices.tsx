// The honest notes about which dataset is on screen: recorded snapshot,
// browser-cached copy, a failed refresh, and the one-time switch to live.
// Shared by Overview and Invoices so both say the same thing.
import { RefreshCw } from 'lucide-react'
import type { AppData } from './hooks'
import { formatDay, recordedLabel } from './fees'
import { clockUtc } from './format'
import { Button, Notice } from './ui'

export function DataNotices({ data, subject = 'numbers' }: { data: AppData; subject?: string }) {
  const retry = (
    <Button small onClick={data.refetch}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
    </Button>
  )
  return (
    <>
      {data.source === 'recorded' ? (
        <Notice tone="warn" action={retry}>
          The live API has not answered yet, so these {subject} are the recorded snapshot from {formatDay(data.asOf ?? '')} ({recordedLabel(data.asOf)}). They are not live and will be replaced once, as soon as the live read arrives.
        </Notice>
      ) : null}
      {data.source === 'cached' ? (
        <Notice>
          Showing the {subject} saved in this browser from the registry scan of {formatDay(data.asOf ?? '')} {clockUtc(data.asOf)}. The live read is on its way and will replace them once.
        </Notice>
      ) : null}
      {data.switched ? (
        <Notice>
          Updated to the live registry: {data.switched.toTotal} payables, {data.switched.toPaid} paid (the {data.switched.from === 'cached' ? 'saved copy' : 'recorded snapshot'} showed {data.switched.fromTotal} and {data.switched.fromPaid}). The registry grew while you were away; this is a one-time change.
        </Notice>
      ) : null}
      {data.stale ? (
        <Notice tone="warn">Could not refresh just now. Showing the last numbers read in this visit. The page retries every 30 s.</Notice>
      ) : null}
    </>
  )
}
