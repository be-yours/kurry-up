"use client"

import { RotateCcw, ChevronDown } from "lucide-react"
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@be-yours/ui"
import { CmsFieldRenderer } from "./CmsFieldRenderer"
import type {
  BlockDefinition,
  CmsFieldValue,
  CmsBlockValues,
} from "@be-yours/cms"

interface CmsBlockAccordionProps {
  blockDef: BlockDefinition
  draftValues: CmsBlockValues
  publishedValues?: CmsBlockValues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolvedMedia: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  translationsByField: Record<string, Record<string, any>>
  onFieldChange: (blockKey: string, fieldKey: string, value: CmsFieldValue) => void
  onFieldReset: (blockKey: string, fieldKey: string) => void
  onBlockReset: (blockKey: string) => void
  onOpenTranslations: (blockKey: string, fieldKey: string) => void
  defaultOpen?: boolean
  disabled?: boolean
}

export function CmsBlockAccordion({
  blockDef,
  draftValues,
  publishedValues,
  resolvedMedia,
  translationsByField,
  onFieldChange,
  onFieldReset,
  onBlockReset,
  onOpenTranslations,
  defaultOpen = true,
  disabled,
}: CmsBlockAccordionProps) {
  const fieldEntries = Object.entries(blockDef.fields)

  // Group fields by their optional `group` property, preserving order
  type FieldEntry = [string, typeof blockDef.fields[string]]
  type GroupItem = { type: "field"; entry: FieldEntry } | { type: "group"; label: string; entries: FieldEntry[] }

  const items: GroupItem[] = []
  const seenGroups = new Set<string>()

  for (const entry of fieldEntries) {
    const [, fieldDef] = entry
    const group = fieldDef.group
    if (group) {
      if (!seenGroups.has(group)) {
        seenGroups.add(group)
        items.push({
          type: "group",
          label: group,
          entries: fieldEntries.filter(([, fd]) => fd.group === group),
        })
      }
    } else {
      items.push({ type: "field", entry })
    }
  }

  const renderField = ([fieldKey, fieldDef]: FieldEntry) => {
    const translationsForField = translationsByField[fieldKey]
    const translationCount = translationsForField
      ? Object.keys(translationsForField).length
      : 0

    return (
      <CmsFieldRenderer
        key={fieldKey}
        fieldKey={fieldKey}
        fieldDef={fieldDef}
        value={draftValues[fieldKey]}
        publishedValue={publishedValues?.[fieldKey]}
        resolvedMedia={resolvedMedia[fieldKey]}
        onChange={(fk, val) => onFieldChange(blockDef.key, fk, val)}
        onReset={(fk) => onFieldReset(blockDef.key, fk)}
        onOpenTranslations={(fk) =>
          onOpenTranslations(blockDef.key, fk)
        }
        translationCount={translationCount}
        disabled={disabled}
      />
    )
  }

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className="rounded-lg border">
        {/* Header */}
        <CollapsibleTrigger asChild>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 sm:px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform [[data-state=closed]_&]:-rotate-90" />
              <h3 className="text-sm font-semibold truncate">{blockDef.label}</h3>
              <span className="text-xs text-muted-foreground shrink-0">
                {fieldEntries.length} champ{fieldEntries.length > 1 ? "s" : ""}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs shrink-0 self-end sm:self-auto"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                onBlockReset(blockDef.key)
              }}
              disabled={disabled}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              Réinitialiser le bloc
            </Button>
          </div>
        </CollapsibleTrigger>

        {/* Body */}
        <CollapsibleContent>
          <div className="px-3 sm:px-4 pb-4 space-y-5 border-t pt-4">
            {items.map((item, idx) => {
              if (item.type === "field") {
                return renderField(item.entry)
              }
              return (
                <div
                  key={item.label}
                  className="rounded-md border bg-muted/20 p-3 space-y-3"
                >
                  <p className="text-xs font-semibold text-muted-foreground">{item.label}</p>
                  {item.entries.map(renderField)}
                </div>
              )
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
