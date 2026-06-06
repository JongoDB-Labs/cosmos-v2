import { CodeSnippet } from "../code-snippet";

export const codeSnippetExamples = [
  {
    label: "Single line",
    node: <CodeSnippet code='npm install @cosmos/ui' />,
    code: `<CodeSnippet code="npm install @cosmos/ui" />`,
  },
  {
    label: "Multi-line",
    node: (
      <CodeSnippet
        code={`const queryKey = useOrgQueryKey("themes");
const { data } = useQuery({ queryKey, queryFn });`}
      />
    ),
    code: `<CodeSnippet
  code={\`const queryKey = useOrgQueryKey("themes");
const { data } = useQuery({ queryKey, queryFn });\`}
/>`,
  },
];
