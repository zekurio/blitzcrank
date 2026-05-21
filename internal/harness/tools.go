package harness

import "context"

func (m *Manager) CallTool(ctx context.Context, name string, args map[string]any) (any, error) {
	return m.tools.Call(ctx, name, args)
}
