package main

import (
	"context"
	"io"
	"os"
	"path/filepath"

	swaggerFiles "github.com/swaggo/files"
)

func main() {
	if len(os.Args) != 2 {
		panic("expected output directory")
	}
	for _, name := range []string{"swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "favicon-32x32.png", "favicon-16x16.png"} {
		file, err := swaggerFiles.FS.OpenFile(context.Background(), "/"+name, os.O_RDONLY, 0)
		if err != nil {
			panic(err)
		}
		bytes, err := io.ReadAll(file)
		if err != nil {
			panic(err)
		}
		if err := file.Close(); err != nil {
			panic(err)
		}
		if err := os.WriteFile(filepath.Join(os.Args[1], name), bytes, 0644); err != nil {
			panic(err)
		}
	}
}
