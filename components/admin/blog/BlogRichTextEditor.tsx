"use client"

import { useState, useCallback } from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import Placeholder from "@tiptap/extension-placeholder"
import CharacterCount from "@tiptap/extension-character-count"
import Image from "@tiptap/extension-image"
import { useEffect } from "react"
import {
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Heading2,
  Heading3,
  Heading4,
  Quote,
  Minus,
  ImageIcon,
  Search,
  Trash2,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import { Button } from "@be-yours/ui"
import { CmsMediaPicker } from "@/components/admin/cms/CmsMediaPicker"
import { UnsplashImagePicker } from "@/components/admin/blog/UnsplashImagePicker"
import { GenerateImageDialog } from "@/components/admin/blog/GenerateImageDialog"
import type { UnsplashPhoto } from "@/components/admin/blog/UnsplashImagePicker"

interface ToolbarButtonProps {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
  disabled?: boolean
}

function ToolbarButton({ active, onClick, children, title, disabled }: ToolbarButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-7 w-7 p-0 ${active ? "bg-muted" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </Button>
  )
}

interface BlogRichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  maxLength?: number
  disabled?: boolean
}

export function BlogRichTextEditor({
  value,
  onChange,
  placeholder = "Redigez votre article...",
  maxLength,
  disabled,
}: BlogRichTextEditorProps) {
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false)
  const [mediaPickerForReplace, setMediaPickerForReplace] = useState(false)
  const [unsplashPickerOpen, setUnsplashPickerOpen] = useState(false)
  const [generateImageDialogOpen, setGenerateImageDialogOpen] = useState(false)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        codeBlock: false,
        code: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "underline text-primary-ink" },
      }),
      Placeholder.configure({ placeholder }),
      Image.configure({
        HTMLAttributes: { class: "rounded-md max-w-full" },
      }),
      ...(maxLength
        ? [CharacterCount.configure({ limit: maxLength })]
        : []),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
  })

  // Sync external value changes
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [value, editor])

  const handleUnsplashSelect = useCallback((photo: UnsplashPhoto) => {
    if (!editor) return
    // Replace current image
    editor.chain().focus().setImage({ src: photo.url, alt: photo.alt }).run()

    // Insert credit paragraph after the image
    const pos = editor.state.selection.to
    editor.chain().focus().insertContentAt(pos, {
      type: "paragraph",
      content: [
        { type: "text", marks: [{ type: "italic" }], text: "Photo : " },
        {
          type: "text",
          marks: [
            { type: "italic" },
            { type: "link", attrs: { href: `${photo.photographerUrl}?utm_source=beindigital&utm_medium=referral`, target: "_blank", rel: "noopener noreferrer" } },
          ],
          text: photo.photographerName,
        },
        { type: "text", marks: [{ type: "italic" }], text: " — " },
        {
          type: "text",
          marks: [
            { type: "italic" },
            { type: "link", attrs: { href: "https://unsplash.com/?utm_source=beindigital&utm_medium=referral", target: "_blank", rel: "noopener noreferrer" } },
          ],
          text: "Unsplash",
        },
      ],
    }).run()

    setUnsplashPickerOpen(false)
  }, [editor])

  const handleMediaReplaceSelect = useCallback((media: { url: string; filename: string }) => {
    if (!editor) return
    editor.chain().focus().setImage({ src: media.url, alt: media.filename }).run()
    setMediaPickerForReplace(false)
  }, [editor])

  const handleGeneratedImageInsert = useCallback((image: { url: string; alt: string }) => {
    if (!editor) return
    editor.chain().focus().setImage({ src: image.url, alt: image.alt }).run()
  }, [editor])

  if (!editor) return null

  const charCount = editor.storage.characterCount?.characters?.() ?? 0

  return (
    <div className="rounded-md border">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1">
        {/* Text formatting */}
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Gras"
          disabled={disabled}
        >
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italique"
          disabled={disabled}
        >
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("link")}
          onClick={() => {
            const raw = window.prompt("URL du lien :")
            if (raw) {
              try {
                const parsed = new URL(raw)
                if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                  return
                }
                editor.chain().focus().setLink({ href: raw }).run()
              } catch {
                // URL invalide — ignore silently
              }
            } else {
              editor.chain().focus().unsetLink().run()
            }
          }}
          title="Lien"
          disabled={disabled}
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Headings */}
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Titre H2"
          disabled={disabled}
        >
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Titre H3"
          disabled={disabled}
        >
          <Heading3 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 4 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
          title="Titre H4"
          disabled={disabled}
        >
          <Heading4 className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Lists */}
        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Liste a puces"
          disabled={disabled}
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Liste numerotee"
          disabled={disabled}
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Block elements */}
        <ToolbarButton
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Citation"
          disabled={disabled}
        >
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Separateur"
          disabled={disabled}
        >
          <Minus className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setMediaPickerOpen(true)}
          title="Inserer une image"
          disabled={disabled}
        >
          <ImageIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setGenerateImageDialogOpen(true)}
          title="Générer une image avec l'IA"
          disabled={disabled}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </ToolbarButton>

        {maxLength && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {charCount}/{maxLength}
          </span>
        )}
      </div>

      {/* Editor */}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none px-3 py-2 min-h-[200px] focus-within:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none"
      />

      {/* BubbleMenu — floating above selected image */}
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor }) => editor.isActive("image")}
        className="flex items-center gap-1 rounded-lg border bg-background shadow-lg px-2 py-1.5"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs px-2"
          onClick={() => setGenerateImageDialogOpen(true)}
        >
          <Sparkles className="h-3 w-3" />
          IA
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs px-2"
          onClick={() => setUnsplashPickerOpen(true)}
        >
          <Search className="h-3 w-3" />
          Unsplash
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs px-2"
          onClick={() => setMediaPickerForReplace(true)}
        >
          <RefreshCw className="h-3 w-3" />
          Remplacer
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs px-2 text-destructive hover:text-destructive"
          onClick={() => editor.chain().focus().deleteSelection().run()}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </BubbleMenu>

      {/* Media Picker for toolbar insert */}
      <CmsMediaPicker
        open={mediaPickerOpen}
        onOpenChange={setMediaPickerOpen}
        kindFilter="image"
        onSelect={(media) => {
          editor.chain().focus().setImage({ src: media.url, alt: media.filename }).run()
          setMediaPickerOpen(false)
        }}
      />

      {/* Media Picker for image replace */}
      <CmsMediaPicker
        open={mediaPickerForReplace}
        onOpenChange={setMediaPickerForReplace}
        kindFilter="image"
        onSelect={handleMediaReplaceSelect}
      />

      {/* Unsplash Picker */}
      <UnsplashImagePicker
        open={unsplashPickerOpen}
        onOpenChange={setUnsplashPickerOpen}
        onSelect={handleUnsplashSelect}
      />

      {/* AI Image Generator */}
      <GenerateImageDialog
        open={generateImageDialogOpen}
        onOpenChange={setGenerateImageDialogOpen}
        onInsert={handleGeneratedImageInsert}
      />
    </div>
  )
}
