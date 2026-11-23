import ProjectWorkspace from '@/components/ProjectWorkspace';
import copy from '@/messages/zh/projects.json';

export const metadata = { title: '项目 · Open Generative AI' };

export default async function ProjectsPage({ params }) {
  return <ProjectWorkspace copy={copy} root="/zh" projectId={(await params).projectId} />;
}
