package main

import (
	"bytes"
	"fmt"
	"mime/multipart"
)

func main() {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	writer.WriteField("photo", `{"type":"static","photo":"attach://profile_photo"}`)
	part, _ := writer.CreateFormFile("profile_photo", "photo.jpg")
	part.Write([]byte("fake_image_data"))
	writer.Close()
	fmt.Println(body.String())
}
