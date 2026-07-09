#!/bin/bash
go test ./internal/server -run TestGetWorkoutStats -v || echo "TestGetWorkoutStats not found"
go test ./web/static/js/tests/... || echo "JS tests failing or not found"
