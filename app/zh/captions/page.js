import CaptionEditor from '@/components/CaptionEditor';
import copy from '@/messages/zh/captions.json';

export const metadata = { title: '字幕编辑器 · Open Generative AI' };

export default function CaptionsPage() {
  return <CaptionEditor copy={copy} studioHref="/zh/studio" />;
}
