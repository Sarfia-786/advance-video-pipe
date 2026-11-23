import CaptionEditor from '@/components/CaptionEditor';
import copy from '@/messages/en/captions.json';

export const metadata = { title: 'Caption editor · Open Generative AI' };

export default function CaptionsPage() {
  return <CaptionEditor copy={copy} studioHref="/studio" />;
}
