package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

// An upstream tool or schema change must update the optional Worker adapter
// in the same change, rather than silently letting the deployments diverge.
func TestCloudflareMCPToolContract(t *testing.T) {
	protocol := mcpserver.NewMCPServer("slashdocs", "test")
	registerMCPTools(protocol, mcpAPIAdapter{})
	tools := make([]mcp.Tool, 0, len(protocol.ListTools()))
	for _, registered := range protocol.ListTools() {
		tools = append(tools, registered.Tool)
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	wantBytes, err := json.Marshal(tools)
	if err != nil {
		t.Fatal(err)
	}
	gotBytes, err := os.ReadFile(filepath.Join("..", "..", "..", "workers", "app", "src", "mcp", "tools.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	if err := json.Unmarshal(wantBytes, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(gotBytes, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("Cloudflare MCP names, descriptions, schemas or annotations differ from registered Go tools; update the Worker contract and adapter together")
	}
}
